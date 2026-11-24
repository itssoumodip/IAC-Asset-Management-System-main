import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { IT_TEAM_ID, date, parse, text, uuid } from './domain-helpers';
import { can } from './policy';
import { inrRates, toInr } from './exchange-rates';
import { AuthRequest, SessionGuard, type Actor } from './security';

/**
 * Subscriptions: software, AI tools, cloud services and anything paid for on a cycle, and the
 * people each one is given to. Only the IT team (and Super Admin) add, change or assign them.
 * Leadership, Finance and auditors can view them; everyone sees their own on My assets.
 */

const CYCLES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'ONE_TIME', 'FREE'] as const;
const STATUSES = ['TRIAL', 'ACTIVE', 'CANCELLED', 'EXPIRED'] as const;
const TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
/** What one cycle costs per month, so monthly spend can be added up across cycles. */
const MONTHLY = `CASE s.billing_cycle WHEN 'MONTHLY' THEN s.cost WHEN 'QUARTERLY' THEN s.cost / 3
  WHEN 'HALF_YEARLY' THEN s.cost / 6 WHEN 'YEARLY' THEN s.cost / 12 ELSE 0 END`;
/** The same in rupees, using the rates passed as $1 (a JSON map of rupees per unit). */
const RATE = `(($1::jsonb) ->> trim(s.currency))::numeric`;
const MONTHLY_INR = `((${MONTHLY}) * ${RATE})`;

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

const subscriptionInput = z
  .object({
    name: text(150),
    vendor: optionalText(150),
    category: text(100),
    plan: optionalText(150),
    billingCycle: z.enum(CYCLES),
    cost: z.union([z.coerce.number().min(0).max(1e12), z.null()]).optional().default(null),
    currency: z.string().trim().length(3).toUpperCase().optional().default('INR'),
    seatsTotal: z.union([z.coerce.number().int().min(1).max(100000), z.null()]).optional().default(null),
    startDate: z.union([date, z.null()]).optional().default(null),
    renewalDate: z.union([date, z.null()]).optional().default(null),
    autoRenew: z.boolean().optional().default(true),
    status: z.enum(STATUSES).optional().default('ACTIVE'),
    accountEmail: optionalText(254),
    website: optionalText(500),
    paymentMethod: optionalText(150),
    departmentId: z.union([uuid, z.null()]).optional().default(null),
    // Who it is for: specific people, a whole department, or everyone.
    audience: z.enum(['PEOPLE', 'DEPARTMENT', 'ORGANISATION']).optional().default('PEOPLE'),
    notes: optionalText(5000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.audience === 'DEPARTMENT' && !v.departmentId)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['departmentId'], message: 'Choose the department this subscription is for' });
    if (v.startDate && v.renewalDate && v.renewalDate < v.startDate)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renewalDate'], message: 'Renewal cannot be before the start date' });
  });
const updateInput = z.intersection(subscriptionInput, z.object({ version: z.number().int().min(1) }));
/** Adding can also give it to people straight away. */
const createInput = z.intersection(
  subscriptionInput,
  z.object({ userIds: z.array(uuid).max(500).optional().default([]) }),
);
const assignInput = z.object({ userId: uuid, note: optionalText(1000) }).strict();
const endInput = z.object({ note: optionalText(1000) }).strict();
const listQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.enum([...STATUSES, 'LIVE'] as const).optional(),
    category: z.string().trim().max(100).optional(),
    renewal: z.enum(['due30', 'passed']).optional(),
    userId: uuid.optional(),
  })
  .strict();

/** IT team members (any level) and Super Admin manage subscriptions. */
export function canManageSubscriptions(actor: Pick<Actor, 'roles' | 'teams'>) {
  return actor.roles.includes('SUPER_ADMIN') || (actor.teams ?? []).some((t) => t.teamId === IT_TEAM_ID);
}
export function canViewSubscriptions(actor: Actor) {
  return canManageSubscriptions(actor) || can(actor, 'report.view') || can(actor, 'asset.finance_edit');
}

const camelRow = (r: any) => ({
  id: r.id,
  code: r.subscription_code,
  name: r.name,
  vendor: r.vendor,
  category: r.category,
  plan: r.plan,
  billingCycle: r.billing_cycle,
  cost: r.cost != null ? Number(r.cost) : null,
  monthlyCost: r.monthly_cost != null ? Math.round(Number(r.monthly_cost) * 100) / 100 : null,
  currency: r.currency,
  seatsTotal: r.seats_total,
  seatsUsed: r.seats_used ?? 0,
  startDate: r.start_date,
  renewalDate: r.renewal_date,
  daysToRenewal: r.days_to_renewal,
  autoRenew: r.auto_renew,
  status: r.status,
  accountEmail: r.account_email,
  website: r.website,
  paymentMethod: r.payment_method,
  departmentId: r.department_id,
  department: r.department_name ?? null,
  audience: r.audience,
  // Changes when a new logo is stored, so browsers fetch the new one.
  logoVersion: r.website ? (r.logo_fetched_at ? new Date(r.logo_fetched_at).getTime() : 0) : null,
  notes: r.notes,
  holders: r.holders ?? [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

/** Adds rupee amounts to a subscription in another currency. */
function withInr<T extends { cost: number | null; monthlyCost: number | null; currency: string }>(s: T, rates: Record<string, number>) {
  return { ...s, costInr: toInr(s.cost, s.currency, rates), monthlyCostInr: toInr(s.monthlyCost, s.currency, rates) };
}

const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp', 'image/gif']);
/** The host of a website field (`openai.com`, `https://chat.openai.com/x`) or null. */
export function websiteDomain(website: string | null | undefined): string | null {
  if (!website?.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`);
    const host = url.hostname.toLowerCase();
    return /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

@Injectable()
export class SubscriptionService {
  constructor(@Inject(Db) private readonly db: Db) {}

  private assertView(actor: Actor) {
    if (!canViewSubscriptions(actor)) throw new ForbiddenException('Insufficient permission');
  }
  private assertManage(actor: Actor) {
    if (!canManageSubscriptions(actor))
      throw new ForbiddenException('Only the IT team can add or change subscriptions');
  }

  private selectSql(where: string) {
    return `
      SELECT s.id, s.subscription_code, s.name, s.vendor, s.category, s.plan, s.billing_cycle, s.cost, s.currency,
             s.seats_total, s.start_date, s.renewal_date, s.auto_renew, s.status, s.account_email, s.website,
             s.payment_method, s.department_id, s.audience, s.notes, s.created_at, s.updated_at, s.version,
             s.logo_fetched_at, d.name AS department_name, (${MONTHLY}) AS monthly_cost,
             (s.renewal_date - ${TODAY}) AS days_to_renewal,
             (SELECT count(*)::int FROM subscription_assignments sa WHERE sa.subscription_id = s.id AND sa.ended_at IS NULL) AS seats_used,
             coalesce((SELECT jsonb_agg(h ORDER BY h.name) FROM (
               SELECT u.id AS "userId", u.display_name AS name,
                      EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id = u.id) AS "hasPhoto"
                 FROM subscription_assignments sa JOIN users u ON u.id = sa.user_id
                WHERE sa.subscription_id = s.id AND sa.ended_at IS NULL
                ORDER BY u.display_name LIMIT 5) h), '[]'::jsonb) AS holders
        FROM subscriptions s
        LEFT JOIN departments d ON d.id = s.department_id
       WHERE ${where}`;
  }

  async list(req: AuthRequest, query: unknown) {
    this.assertView(req.user);
    const p = parse(listQuery, query ?? {});
    const values: unknown[] = [];
    const where = ['TRUE'];
    if (p.status === 'LIVE') where.push("s.status IN ('ACTIVE','TRIAL')");
    else if (p.status) {
      values.push(p.status);
      where.push(`s.status = $${values.length}`);
    }
    if (p.category) {
      values.push(p.category);
      where.push(`s.category = $${values.length}`);
    }
    if (p.renewal === 'due30')
      where.push(`s.status IN ('ACTIVE','TRIAL') AND s.renewal_date BETWEEN ${TODAY} AND ${TODAY} + 30`);
    if (p.renewal === 'passed') where.push(`s.status IN ('ACTIVE','TRIAL') AND s.renewal_date < ${TODAY}`);
    if (p.userId) {
      values.push(p.userId);
      where.push(`EXISTS(SELECT 1 FROM subscription_assignments sa WHERE sa.subscription_id = s.id AND sa.ended_at IS NULL AND sa.user_id = $${values.length})`);
    }
    if (p.q) {
      values.push(`%${p.q.replace(/[\\%_]/g, '\\$&')}%`);
      const i = values.length;
      where.push(`(s.name ILIKE $${i} OR s.vendor ILIKE $${i} OR s.plan ILIKE $${i} OR s.subscription_code ILIKE $${i}
        OR s.account_email ILIKE $${i}
        OR s.id IN (SELECT sa.subscription_id FROM subscription_assignments sa JOIN users u ON u.id = sa.user_id
                    WHERE sa.ended_at IS NULL AND u.display_name ILIKE $${i}))`);
    }
    const rows = await this.db.query(
      `${this.selectSql(where.join(' AND '))}
       ORDER BY CASE WHEN s.status IN ('ACTIVE','TRIAL') THEN 0 ELSE 1 END,
                s.renewal_date NULLS LAST, s.name
       LIMIT 1000`,
      values,
    );
    const fx = await inrRates(this.db);
    return { items: rows.map((row: any) => withInr(camelRow(row), fx.rates)) };
  }

  /** Numbers and chart data for the page and dashboards. */
  async summary(req: AuthRequest) {
    this.assertView(req.user);
    const live = "s.status IN ('ACTIVE','TRIAL')";
    const fx = await inrRates(this.db);
    const r = [JSON.stringify(fx.rates)];
    const [[t], byCategory, months, upcoming, people] = await Promise.all([
      this.db.query(`
        SELECT count(*) FILTER (WHERE ${live})::int AS live,
               count(*) FILTER (WHERE s.status = 'TRIAL')::int AS trials,
               coalesce(sum(${MONTHLY_INR}) FILTER (WHERE ${live}), 0)::float8 AS monthly,
               count(*) FILTER (WHERE ${live} AND s.cost IS NOT NULL AND ${RATE} IS NULL)::int AS unconverted,
               count(*) FILTER (WHERE ${live} AND s.renewal_date BETWEEN ${TODAY} AND ${TODAY} + 30)::int AS due30,
               count(*) FILTER (WHERE ${live} AND s.renewal_date < ${TODAY})::int AS passed,
               coalesce(sum(s.seats_total) FILTER (WHERE ${live}), 0)::int AS seats_total,
               (SELECT count(*)::int FROM subscription_assignments sa JOIN subscriptions s2 ON s2.id = sa.subscription_id
                 WHERE sa.ended_at IS NULL AND s2.status IN ('ACTIVE','TRIAL') AND s2.seats_total IS NOT NULL) AS seats_used,
               (SELECT count(DISTINCT sa.user_id)::int FROM subscription_assignments sa JOIN subscriptions s2 ON s2.id = sa.subscription_id
                 WHERE sa.ended_at IS NULL AND s2.status IN ('ACTIVE','TRIAL')) AS people,
               count(*) FILTER (WHERE ${live} AND s.seats_total IS NOT NULL
                 AND (SELECT count(*) FROM subscription_assignments sa WHERE sa.subscription_id = s.id AND sa.ended_at IS NULL) < s.seats_total)::int AS with_free_seats
          FROM subscriptions s`, r),
      this.db.query(`
        SELECT s.category AS label, count(*)::int AS count, coalesce(sum(${MONTHLY_INR}), 0)::float8 AS monthly
          FROM subscriptions s WHERE ${live}
         GROUP BY 1 ORDER BY 3 DESC, 2 DESC, 1`, r),
      this.db.query(`
        WITH m AS (SELECT generate_series(date_trunc('month', ${TODAY}), date_trunc('month', ${TODAY}) + interval '11 months', interval '1 month')::date AS month)
        SELECT m.month, count(s.id)::int AS renewals, coalesce(sum(s.cost * ${RATE}), 0)::float8 AS cost
          FROM m LEFT JOIN subscriptions s
            ON ${live} AND s.renewal_date >= greatest(m.month, ${TODAY}) AND s.renewal_date < m.month + interval '1 month'
         GROUP BY m.month ORDER BY m.month`, r),
      this.db.query(`
        SELECT s.id, s.name, s.vendor, s.renewal_date, s.cost::float8 AS cost, s.currency, s.auto_renew,
               (s.renewal_date - ${TODAY}) AS days
          FROM subscriptions s
         WHERE ${live} AND s.renewal_date IS NOT NULL AND s.renewal_date <= ${TODAY} + 60
         ORDER BY s.renewal_date LIMIT 6`),
      this.db.query(`
        SELECT u.id, u.display_name AS name, EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id = u.id) AS has_photo,
               count(*)::int AS count, coalesce(sum(CASE WHEN s.seats_total IS NULL OR s.seats_total = 0 THEN 0
                 ELSE ${MONTHLY_INR} / s.seats_total END), 0)::float8 AS monthly_share
          FROM subscription_assignments sa JOIN subscriptions s ON s.id = sa.subscription_id
          JOIN users u ON u.id = sa.user_id
         WHERE sa.ended_at IS NULL AND ${live}
         GROUP BY u.id, u.display_name ORDER BY 4 DESC, 2 LIMIT 8`, r),
    ]);
    return {
      live: t.live,
      trials: t.trials,
      monthlySpend: Number(t.monthly),
      yearlySpend: Number(t.monthly) * 12,
      renewalsDue30: t.due30,
      renewalsPassed: t.passed,
      seatsTotal: t.seats_total,
      seatsUsed: t.seats_used,
      peopleCount: t.people,
      withFreeSeats: t.with_free_seats,
      // Totals are in rupees at these rates; plans in a currency without a rate are left out.
      rates: { asOf: fx.asOf, stale: fx.stale, unconverted: t.unconverted },
      byCategory: byCategory.map((r: any) => ({ label: r.label, count: r.count, monthly: Number(r.monthly) })),
      months: months.map((m: any) => ({ month: m.month, renewals: m.renewals, cost: Number(m.cost) })),
      upcoming: upcoming.map((r: any) => ({
        id: r.id,
        name: r.name,
        vendor: r.vendor,
        renewalDate: r.renewal_date,
        days: r.days,
        cost: r.cost,
        costInr: toInr(r.cost, r.currency, fx.rates),
        currency: r.currency,
        autoRenew: r.auto_renew,
      })),
      topPeople: people.map((r: any) => ({ userId: r.id, name: r.name, hasPhoto: r.has_photo, count: r.count, monthlyShare: Number(r.monthly_share) })),
    };
  }

  /** The signed-in person's own subscriptions (shown on My assets). */
  async mine(req: AuthRequest) {
    const rows = await this.db.query(
      // Given to this person by name, plus live plans for their department or for everyone.
      `SELECT s.id, s.name, s.vendor, s.plan, s.category, s.status, s.renewal_date, s.website,
              sa.assigned_at, CASE WHEN sa.id IS NOT NULL THEN 'PERSON' ELSE s.audience END AS via
         FROM subscriptions s
         LEFT JOIN subscription_assignments sa ON sa.subscription_id = s.id AND sa.user_id = $1 AND sa.ended_at IS NULL
        WHERE sa.id IS NOT NULL
           OR (s.status IN ('ACTIVE','TRIAL') AND (s.audience = 'ORGANISATION'
               OR (s.audience = 'DEPARTMENT' AND s.department_id = (SELECT department_id FROM users WHERE id = $1))))
        ORDER BY s.name`,
      [req.user.id],
    );
    return {
      items: rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        vendor: r.vendor,
        plan: r.plan,
        category: r.category,
        status: r.status,
        renewalDate: r.renewal_date,
        website: r.website,
        assignedAt: r.assigned_at,
        via: r.via as 'PERSON' | 'DEPARTMENT' | 'ORGANISATION',
      })),
    };
  }

  async detail(req: AuthRequest, id: string) {
    this.assertView(req.user);
    const sid = parse(uuid, id);
    const [row] = await this.db.query(`${this.selectSql('s.id = $1')}`, [sid]);
    if (!row) throw new NotFoundException('Subscription not found');
    const people = await this.db.query(
      `SELECT sa.id, sa.user_id, u.display_name AS name, u.email, u.designation, d.name AS department,
              (u.left_at IS NOT NULL) AS left_org,
              EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id = u.id) AS has_photo,
              sa.assigned_at, sa.note, ab.display_name AS assigned_by_name,
              sa.ended_at, sa.end_note, eb.display_name AS ended_by_name
         FROM subscription_assignments sa
         JOIN users u ON u.id = sa.user_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN users ab ON ab.id = sa.assigned_by
         LEFT JOIN users eb ON eb.id = sa.ended_by
        WHERE sa.subscription_id = $1
        ORDER BY sa.ended_at NULLS FIRST, u.display_name`,
      [sid],
    );
    const mapPerson = (r: any) => ({
      assignmentId: r.id,
      userId: r.user_id,
      name: r.name,
      email: r.email,
      designation: r.designation,
      department: r.department,
      left: r.left_org,
      hasPhoto: r.has_photo,
      assignedAt: r.assigned_at,
      note: r.note,
      assignedBy: r.assigned_by_name,
      endedAt: r.ended_at,
      endNote: r.end_note,
      endedBy: r.ended_by_name,
    });
    const fx = await inrRates(this.db);
    return {
      ...withInr(camelRow(row), fx.rates),
      rateAsOf: fx.asOf,
      people: people.filter((r: any) => !r.ended_at).map(mapPerson),
      history: people.filter((r: any) => r.ended_at).map(mapPerson),
      canManage: canManageSubscriptions(req.user),
    };
  }

  private async checkReferences(input: { category: string; departmentId: string | null }) {
    const [cat] = await this.db.query(
      "SELECT 1 FROM reference_values WHERE kind = 'SUBSCRIPTION_CATEGORY' AND code = $1 AND active",
      [input.category],
    );
    if (!cat) throw new UnprocessableEntityException('Choose a subscription type from the list');
    if (input.departmentId) {
      const [dep] = await this.db.query('SELECT 1 FROM departments WHERE id = $1', [input.departmentId]);
      if (!dep) throw new UnprocessableEntityException('Unknown department');
    }
  }

  private values(v: z.infer<typeof subscriptionInput>) {
    return [
      v.name, v.vendor, v.category, v.plan, v.billingCycle, v.billingCycle === 'FREE' ? 0 : v.cost, v.currency,
      v.seatsTotal, v.startDate, v.renewalDate, v.autoRenew, v.status, v.accountEmail, v.website,
      v.paymentMethod, v.audience === 'ORGANISATION' ? null : v.departmentId, v.notes, v.audience,
    ];
  }

  async create(req: AuthRequest, body: unknown) {
    this.assertManage(req.user);
    const { userIds, ...input } = parse(createInput, body);
    await this.checkReferences(input);
    const people = [...new Set(userIds)];
    if (input.seatsTotal != null && people.length > input.seatsTotal)
      throw new ConflictException(`You picked ${people.length} people but the plan has ${input.seatsTotal} seats`);
    if (people.length && !['ACTIVE', 'TRIAL'].includes(input.status))
      throw new ConflictException('Only active or trial subscriptions can be given to people');
    return this.db.tx(async (c) => {
      if (people.length) {
        const ok = await this.db.query(
          "SELECT id FROM users WHERE id = ANY($1::uuid[]) AND state IN ('ACTIVE','INVITED','DIRECTORY') AND left_at IS NULL",
          [people],
          c,
        );
        if (ok.length !== people.length) throw new UnprocessableEntityException('Some chosen people are not active staff');
      }
      const [row] = await this.db.query(
        `INSERT INTO subscriptions(name, vendor, category, plan, billing_cycle, cost, currency, seats_total,
            start_date, renewal_date, auto_renew, status, account_email, website, payment_method,
            department_id, notes, audience, owning_team_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, subscription_code`,
        [...this.values(input), IT_TEAM_ID, req.user.id],
        c,
      );
      for (const userId of people)
        await this.db.query(
          'INSERT INTO subscription_assignments(subscription_id, user_id, assigned_by) VALUES($1, $2, $3)',
          [row.id, userId, req.user.id],
          c,
        );
      await this.db.audit(c, req.user, 'subscription', row.id, 'SUBSCRIPTION_CREATED', { after: input, userIds: people });
      return { id: row.id, code: row.subscription_code };
    });
  }

  async update(req: AuthRequest, id: string, body: unknown) {
    this.assertManage(req.user);
    const sid = parse(uuid, id);
    const { version, ...input } = parse(updateInput, body);
    await this.checkReferences(input);
    return this.db.tx(async (c) => {
      const [before] = await this.db.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [sid], c);
      if (!before) throw new NotFoundException('Subscription not found');
      if (before.version !== version)
        throw new ConflictException('Someone else changed this subscription. Reload and try again.');
      if (input.seatsTotal != null) {
        const [{ used }] = await this.db.query(
          'SELECT count(*)::int AS used FROM subscription_assignments WHERE subscription_id = $1 AND ended_at IS NULL',
          [sid],
          c,
        );
        if (used > input.seatsTotal)
          throw new ConflictException(`${used} people use it now; remove some before lowering seats to ${input.seatsTotal}`);
      }
      await this.db.query(
        `UPDATE subscriptions SET name=$1, vendor=$2, category=$3, plan=$4, billing_cycle=$5, cost=$6, currency=$7,
            seats_total=$8, start_date=$9, renewal_date=$10, auto_renew=$11, status=$12, account_email=$13,
            website=$14, payment_method=$15, department_id=$16, notes=$17, audience=$18, updated_at=now(), version=version+1,
            logo = CASE WHEN website IS DISTINCT FROM $14 THEN NULL ELSE logo END,
            logo_mime = CASE WHEN website IS DISTINCT FROM $14 THEN NULL ELSE logo_mime END,
            logo_fetched_at = CASE WHEN website IS DISTINCT FROM $14 THEN NULL ELSE logo_fetched_at END
          WHERE id=$19`,
        [...this.values(input), sid],
        c,
      );
      await this.db.audit(c, req.user, 'subscription', sid, 'SUBSCRIPTION_UPDATED', { before, after: input });
      return { id: sid, version: version + 1 };
    });
  }

  async assign(req: AuthRequest, id: string, body: unknown) {
    this.assertManage(req.user);
    const sid = parse(uuid, id);
    const input = parse(assignInput, body);
    return this.db.tx(async (c) => {
      const [s] = await this.db.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [sid], c);
      if (!s) throw new NotFoundException('Subscription not found');
      if (!['ACTIVE', 'TRIAL'].includes(s.status))
        throw new ConflictException('Only active or trial subscriptions can be given to people');
      const [person] = await this.db.query(
        "SELECT id, left_at FROM users WHERE id = $1 AND state IN ('ACTIVE','INVITED','DIRECTORY')",
        [input.userId],
        c,
      );
      if (!person) throw new UnprocessableEntityException('Choose an active person');
      if (person.left_at) throw new UnprocessableEntityException('This person has left the organisation');
      const [{ used }] = await this.db.query(
        'SELECT count(*)::int AS used FROM subscription_assignments WHERE subscription_id = $1 AND ended_at IS NULL',
        [sid],
        c,
      );
      if (s.seats_total != null && used >= s.seats_total)
        throw new ConflictException(`All ${s.seats_total} seats are in use. Free a seat or add more seats first.`);
      const [existing] = await this.db.query(
        'SELECT 1 FROM subscription_assignments WHERE subscription_id = $1 AND user_id = $2 AND ended_at IS NULL',
        [sid, input.userId],
        c,
      );
      if (existing) throw new ConflictException('This person already has this subscription');
      const [row] = await this.db.query(
        `INSERT INTO subscription_assignments(subscription_id, user_id, assigned_by, note) VALUES($1,$2,$3,$4) RETURNING id`,
        [sid, input.userId, req.user.id, input.note],
        c,
      );
      await this.db.audit(c, req.user, 'subscription', sid, 'SUBSCRIPTION_ASSIGNED', { userId: input.userId, note: input.note });
      return { assignmentId: row.id };
    });
  }

  /**
   * The vendor's logo. Fetched on first request from Google's public favicon service using only
   * the website's domain (no personal data), stored, then served from this site. A failed fetch
   * is retried after a week. Any signed-in person may see a logo.
   */
  async logo(id: string): Promise<{ content: Buffer; mime: string } | null> {
    const sid = parse(uuid, id);
    const [row] = await this.db.query(
      'SELECT website, logo, logo_mime, logo_fetched_at FROM subscriptions WHERE id = $1',
      [sid],
    );
    if (!row) throw new NotFoundException('Subscription not found');
    if (row.logo) return { content: row.logo, mime: row.logo_mime };
    const domain = websiteDomain(row.website);
    const fresh = row.logo_fetched_at && Date.now() - new Date(row.logo_fetched_at).getTime() < 7 * 864e5;
    if (!domain || fresh) return null;
    let content: Buffer | null = null;
    let mime: string | null = null;
    try {
      const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (res.ok && LOGO_TYPES.has(type)) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > 0 && bytes.length <= 200000) {
          content = bytes;
          mime = type;
        }
      }
    } catch {
      // Offline or blocked: show initials and try again later.
    }
    await this.db.query(
      'UPDATE subscriptions SET logo = $2, logo_mime = $3, logo_fetched_at = now() WHERE id = $1',
      [sid, content, mime],
    );
    return content && mime ? { content, mime } : null;
  }

  async end(req: AuthRequest, id: string, assignmentId: string, body: unknown) {
    this.assertManage(req.user);
    const sid = parse(uuid, id);
    const aid = parse(uuid, assignmentId);
    const input = parse(endInput, body ?? {});
    return this.db.tx(async (c) => {
      const [row] = await this.db.query(
        `UPDATE subscription_assignments SET ended_at = now(), ended_by = $3, end_note = $4
          WHERE id = $1 AND subscription_id = $2 AND ended_at IS NULL RETURNING user_id`,
        [aid, sid, req.user.id, input.note],
        c,
      );
      if (!row) throw new ConflictException('This person no longer has this subscription');
      await this.db.audit(c, req.user, 'subscription', sid, 'SUBSCRIPTION_UNASSIGNED', { userId: row.user_id, note: input.note });
      return { ended: true };
    });
  }
}

@Controller('subscriptions')
@UseGuards(SessionGuard)
export class SubscriptionController {
  constructor(@Inject(SubscriptionService) private readonly service: SubscriptionService) {}

  @Get()
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.list(req, query);
  }
  @Get('summary')
  summary(@Req() req: AuthRequest) {
    return this.service.summary(req);
  }
  @Get('mine')
  mine(@Req() req: AuthRequest) {
    return this.service.mine(req);
  }
  @Get(':id/logo')
  async logo(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const logo = await this.service.logo(id);
    if (!logo) throw new NotFoundException('No logo');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(logo.content, { type: logo.mime });
  }
  @Get(':id')
  detail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.detail(req, id);
  }
  @Post()
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }
  @Put(':id')
  update(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(req, id, body);
  }
  @Post(':id/people')
  assign(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.assign(req, id, body);
  }
  @Post(':id/people/:assignmentId/end')
  end(@Req() req: AuthRequest, @Param('id') id: string, @Param('assignmentId') assignmentId: string, @Body() body: unknown) {
    return this.service.end(req, id, assignmentId, body);
  }
}
