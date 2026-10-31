import { ForbiddenException } from '@nestjs/common';

export type GlobalRole =
  | 'SUPER_ADMIN'
  | 'FINANCE'
  | 'EXECUTIVE'
  | 'EMPLOYEE'
  | 'STORE'
  | 'AUDITOR'
  | 'TECHNICIAN'
  | 'INSURER'
  | 'PROCUREMENT';
export type TeamLevel = 'LEAD' | 'MEMBER';
export interface TeamMembership { teamId: string; teamCode: string; level: TeamLevel }
export interface PolicyActor {
  roles: string[];
  teams?: TeamMembership[];
  assetViewFields?: string[];
}
export type Action =
  | 'asset.view_all' | 'asset.view_private' | 'asset.create' | 'asset.edit' | 'asset.custody'
  | 'asset.retire' | 'asset.import' | 'asset.label' | 'asset.photo' | 'asset.finance_edit'
  | 'asset.change_team' | 'team.manage_members' | 'ticket.work' | 'announcement.send'
  | 'report.view' | 'system.admin';

export const TEAM_SCOPED: ReadonlySet<Action> = new Set<Action>([
  'asset.create', 'asset.edit', 'asset.custody', 'asset.retire', 'asset.import',
  'asset.label', 'asset.photo', 'team.manage_members'
]);

export const FINANCE_FIELDS: readonly string[] = [
  'purchaseDate', 'purchaseCost', 'currency', 'residualValue', 'depreciationMethod',
  'usefulLifeYears', 'invoiceNumber', 'supplier', 'insurancePolicyNumber', 'insuranceExpiry', 'financePending'
];

export const INSURER_ASSET_FIELDS: readonly string[] = [
  'description',
  'purchase_cost',
  'purchase_date',
];

export const FIELD_PERMISSION_ROLES = [
  'STORE',
  'AUDITOR',
  'TECHNICIAN',
  'INSURER',
  'PROCUREMENT',
] as const;
export const ASSET_PERMISSION_FIELDS = [
  'description',
  'purchase_cost',
  'purchase_date',
  'serial_number',
  'location_id',
  'status',
  'condition',
] as const;
export const ASSET_FIELD_OWNERS: Readonly<Record<string, GlobalRole>> = {
  description: 'AUDITOR',
  purchase_cost: 'FINANCE',
  purchase_date: 'FINANCE',
  serial_number: 'AUDITOR',
  location_id: 'STORE',
  status: 'STORE',
  condition: 'TECHNICIAN',
};

export function approvalOwner(fields: string[], roles: string[]): GlobalRole | null {
  if (roles.includes('SUPER_ADMIN')) return null;
  const owners = [...new Set(fields.map((field) => ASSET_FIELD_OWNERS[field]).filter(Boolean))];
  const owner = owners[0];
  if (owners.length !== 1 || !owner || roles.includes(owner)) return null;
  return owner;
}

export function visibleAssetFields(actor: PolicyActor): string[] {
  if (!actor.roles.includes('INSURER')) return [];
  return actor.assetViewFields === undefined ? [...INSURER_ASSET_FIELDS] : actor.assetViewFields;
}

export const WRITE_OFF_STATUSES: ReadonlySet<string> = new Set(['Retired', 'Disposed', 'Sold', 'Lost', 'Stolen', 'Scrapped']);

interface Rule {
  superAdmin: boolean;
  lead: boolean; // for TEAM_SCOPED actions: held at own team; otherwise: any membership
  member: boolean;
  roles: readonly GlobalRole[]; // other global roles that grant it globally
}

const R = (superAdmin: boolean, lead: boolean, member: boolean, roles: GlobalRole[] = []): Rule =>
  ({ superAdmin, lead, member, roles });

const RULES: Record<Action, Rule> = {
  'asset.view_all': R(true, true, true, [
    'FINANCE', 'EXECUTIVE', 'STORE', 'AUDITOR', 'TECHNICIAN', 'INSURER', 'PROCUREMENT'
  ]),
  'asset.view_private': R(true, true, true, ['FINANCE', 'EXECUTIVE']),
  'asset.create': R(true, true, true),
  'asset.edit': R(true, true, true),
  'asset.custody': R(true, true, true, ['STORE']),
  'asset.retire': R(true, true, false),
  'asset.import': R(true, true, false),
  'asset.label': R(true, true, true),
  'asset.photo': R(true, true, true),
  'asset.finance_edit': R(true, false, false, ['FINANCE']),
  'asset.change_team': R(true, false, false),
  'team.manage_members': R(true, true, false),
  'ticket.work': R(true, true, true, ['TECHNICIAN']),
  'announcement.send': R(true, true, true),
  'report.view': R(true, false, false, ['EXECUTIVE', 'FINANCE', 'AUDITOR']),
  'system.admin': R(true, false, false)
};

const ACTIONS = Object.keys(RULES) as Action[];
const isSuper = (a: PolicyActor) => a.roles.includes('SUPER_ADMIN');
const levelOk = (rule: Rule, level: TeamLevel) => (level === 'LEAD' ? rule.lead : rule.member);

export function can(actor: PolicyActor, action: Action, teamId?: string): boolean {
  if (isSuper(actor)) return true;
  if (action === 'asset.view_private' && actor.roles.some((role) => ['TECHNICIAN', 'AUDITOR'].includes(role)))
    return false;
  const rule = RULES[action];
  if (rule.roles.some((r) => actor.roles.includes(r))) return true;
  const teams = actor.teams ?? [];
  if (TEAM_SCOPED.has(action)) {
    if (!teamId) return false;
    return teams.some((t) => t.teamId === teamId && levelOk(rule, t.level));
  }
  return teams.some((t) => levelOk(rule, t.level));
}

export function assertCan(actor: PolicyActor, action: Action, teamId?: string): void {
  if (!can(actor, action, teamId)) throw new ForbiddenException('Insufficient permission');
}

/**
 * Which teams an action applies to, for scoping list queries. Non-team-scoped
 * actions (view_all, ticket.work, ...) are global: 'ALL' if the actor can do
 * them at all, otherwise []. Team-scoped actions return the actor's team ids
 * where their level grants the action (or 'ALL' for global grants).
 */
export function teamsFor(actor: PolicyActor, action: Action): 'ALL' | string[] {
  if (isSuper(actor)) return 'ALL';
  if (!TEAM_SCOPED.has(action)) return can(actor, action) ? 'ALL' : [];
  const rule = RULES[action];
  if (rule.roles.some((r) => actor.roles.includes(r))) return 'ALL';
  return (actor.teams ?? []).filter((t) => levelOk(rule, t.level)).map((t) => t.teamId);
}

export function capabilities(actor: PolicyActor): { global: Action[]; teams: Record<string, Action[]> } {
  const global: Action[] = [];
  const teams: Record<string, Action[]> = {};
  const superAdmin = isSuper(actor);
  for (const action of ACTIONS) {
    const rule = RULES[action];
    if (superAdmin || rule.roles.some((r) => actor.roles.includes(r))) {
      global.push(action);
      continue;
    }
    if (TEAM_SCOPED.has(action)) {
      for (const t of actor.teams ?? []) {
        if (levelOk(rule, t.level)) (teams[t.teamId] ??= []).push(action);
      }
    } else if ((actor.teams ?? []).some((t) => levelOk(rule, t.level))) {
      global.push(action);
    }
  }
  return { global, teams };
}

export function privileged(actor: PolicyActor): boolean {
  return actor.roles.some((r) => r !== 'EMPLOYEE') || (actor.teams ?? []).length > 0;
}
