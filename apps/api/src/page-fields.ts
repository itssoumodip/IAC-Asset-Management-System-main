import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Db } from './db';
import { assetFieldRestrictions } from './role-field';

/**
 * Field permissions for pages other than the asset catalog (Subscriptions, Vendors, People).
 * They are saved on the Field permissions page in the same table as asset fields, named
 * `<page>_<field>` (for example `subscription_cost`), and follow the same rule: a field is hidden
 * or locked only when every role the person holds has it unticked; Super Admin is never limited.
 *
 * Each field lists the response properties it covers (`show`; lists become empty, everything
 * else null, which the pages already treat as "not recorded") and the form inputs it protects
 * (`input`; a change to a locked one is refused).
 */
type FieldSpec = { show: string[]; input?: string[]; list?: boolean };
export const PAGE_FIELDS = {
  subscription: {
    vendor: { show: ['vendor'], input: ['vendor'] },
    plan: { show: ['plan'], input: ['plan'] },
    cost: { show: ['cost', 'currency', 'monthlyCost', 'costInr', 'monthlyCostInr'], input: ['cost', 'currency'] },
    billingCycle: { show: ['billingCycle'], input: ['billingCycle'] },
    renewal: { show: ['startDate', 'renewalDate', 'daysToRenewal', 'autoRenew'], input: ['startDate', 'renewalDate', 'autoRenew'] },
    seats: { show: ['seatsTotal', 'seatsUsed'], input: ['seatsTotal'] },
    people: { show: ['holders', 'people', 'history'], list: true },
    department: { show: ['departmentId', 'department'], input: ['departmentId'] },
    accountEmail: { show: ['accountEmail'], input: ['accountEmail'] },
    paymentMethod: { show: ['paymentMethod'], input: ['paymentMethod'] },
    website: { show: ['website', 'logoVersion'], input: ['website'] },
    notes: { show: ['notes'], input: ['notes'] },
  },
  vendor: {
    services: { show: ['services'], input: ['services'] },
    contactPerson: { show: ['contactPerson'], input: ['contactPerson'] },
    phone: { show: ['phone'], input: ['phone'] },
    email: { show: ['email'], input: ['email'] },
    address: { show: ['address'], input: ['address'] },
    website: { show: ['website'], input: ['website'] },
    gstin: { show: ['gstin'], input: ['gstin'] },
    score: { show: ['score'], input: ['score'] },
    notes: { show: ['notes'], input: ['notes'] },
    referencePeople: { show: ['referencePeople'], input: ['referenceUserIds'], list: true },
    assets: { show: ['assets', 'assetCount', 'assetValue'], list: true },
    subscriptions: { show: ['subscriptions', 'subscriptionCount'] },
  },
  person: {
    email: { show: ['email'] },
    employeeCode: { show: ['employeeCode'] },
    designation: { show: ['designation'] },
    department: { show: ['department'] },
    manager: { show: ['manager'] },
    assets: { show: ['assets', 'pastAssets'], list: true },
    subscriptions: { show: ['subscriptions'] },
    tickets: { show: ['tickets'] },
  },
} satisfies Record<string, Record<string, FieldSpec>>;
export type Page = keyof typeof PAGE_FIELDS;

type Actor = { roles: string[]; teams?: { level: string }[] };

/** Which of a page's fields this person may not see / not change. */
export async function pageRestrictions(db: Db, actor: Actor, page: Page, client?: PoolClient) {
  const all = await assetFieldRestrictions(db, actor, client);
  const prefix = `${page}_`;
  const pick = (set: Set<string>) =>
    new Set([...set].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)));
  return { hidden: pick(all.hidden), locked: pick(all.locked) };
}

/** Blanks hidden fields on one response object (in place) and returns it. */
export function hideFields<T extends Record<string, any>>(item: T, page: Page, hidden: Set<string>): T {
  const fields = PAGE_FIELDS[page] as Record<string, FieldSpec>;
  for (const name of hidden) {
    const spec = fields[name];
    if (!spec) continue;
    for (const key of spec.show) if (key in item) (item as any)[key] = Array.isArray(item[key]) || spec.list ? [] : null;
  }
  return item;
}

/**
 * Locked fields keep what they had: their inputs are replaced with the current values in
 * `before` (by input name), or with `before`'s defaults / empty for something new. A form that
 * never showed the field (hidden) therefore saves without wiping it.
 */
export function keepLockedValues<T extends Record<string, unknown>>(
  page: Page,
  locked: Set<string>,
  before: Record<string, unknown>,
  input: T,
): T {
  const fields = PAGE_FIELDS[page] as Record<string, FieldSpec>;
  for (const name of locked)
    for (const key of fields[name]?.input ?? [])
      if (key in input) (input as any)[key] = key in before ? before[key] : Array.isArray(input[key]) ? [] : null;
  return input;
}

/** For actions that are a locked field on their own (giving a subscription to someone). */
export function refuseIfLocked(locked: Set<string>, name: string, message: string) {
  if (locked.has(name)) throw new ForbiddenException(message);
}
