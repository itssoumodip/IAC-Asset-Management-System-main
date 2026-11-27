import { BadRequestException, Controller, ForbiddenException, Get, Inject, Injectable, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import {
  BLANK_TEXT,
  LIVE_ASSET,
  assetScope,
  filterList,
  idOrNoneClause,
  isIdOrNone,
  parse,
  uuid,
} from './domain-helpers';
import { inrRates, toInr } from './exchange-rates';
import { can } from './policy';
import { AuthRequest, SessionGuard, type Actor } from './security';
import { canViewSubscriptions } from './subscriptions';
import { hideFields, pageRestrictions } from './page-fields';

/**
 * Person pages: everything one person holds (assets, subscriptions), what they held before, and
 * their support tickets. What a viewer sees follows the usual rules: assets in their scope only,
 * money only with cost access, subscriptions only for those who may view them. Anyone may open
 * their own page.
 */

const listQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    holding: z.enum(['any', 'assets', 'subscriptions']).optional(),
    // Like the asset catalog: one value or several, comma-separated.
    // Department ids, or "none" for people with no department.
    departmentId: z.string().max(3800).optional(),
    // current = still with IAC, left = has left.
    status: z.string().max(40).optional(),
    // Text in the designation, or __blank__ for none.
    designation: z.string().trim().max(100).optional(),
    // How many assets / subscriptions they hold: 0, 1, 2-4, 5+ (subscriptions: 0, 1+).
    assets: z.string().max(40).optional(),
    subscriptions: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .strict();

function canBrowsePeople(actor: Actor) {
  return can(actor, 'asset.view_all') || can(actor, 'report.view') || canViewSubscriptions(actor);
}

@Injectable()
export class PersonProfileService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** People with how much each holds (assets in the viewer's scope, subscriptions if allowed). */
  async list(req: AuthRequest, query: unknown) {
    if (!canBrowsePeople(req.user)) throw new ForbiddenException('Insufficient permission');
    const p = parse(listQuery, query ?? {});
    const values: unknown[] = [];
    const scope = assetScope(req.user, values);
    const subs = canViewSubscriptions(req.user);
    const where = ["u.state IN ('ACTIVE','INVITED','DIRECTORY')", 'u.merged_into_user_id IS NULL'];
    if (p.q) {
      values.push(`%${p.q.replace(/[\\%_]/g, '\\$&')}%`);
      const i = values.length;
      where.push(`(u.display_name ILIKE $${i} OR u.email ILIKE $${i} OR u.employee_code ILIKE $${i} OR u.designation ILIKE $${i})`);
    }
    const departments = filterList(p.departmentId);
    if (departments.length) {
      if (!departments.every(isIdOrNone)) throw new BadRequestException('Invalid department');
      where.push(idOrNoneClause('u.department_id', departments, values));
    }
    const statuses = filterList(p.status);
    if (statuses.some((s) => s !== 'current' && s !== 'left')) throw new BadRequestException('Invalid staff status');
    if (statuses.length === 1) where.push(statuses[0] === 'current' ? 'u.left_at IS NULL' : 'u.left_at IS NOT NULL');
    if (p.designation === BLANK_TEXT) where.push("nullif(btrim(u.designation),'') IS NULL");
    else if (p.designation) {
      values.push(`%${p.designation.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`u.designation ILIKE $${values.length}`);
    }
    const base = `SELECT u.id, u.display_name, u.email, u.designation, u.employee_code, (u.left_at IS NOT NULL) AS left_org,
                d.name AS department, EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id = u.id) AS has_photo,
                (SELECT count(*)::int FROM assignments g JOIN assets a ON a.id = g.asset_id
                  WHERE g.user_id = u.id AND g.ended_at IS NULL AND ${LIVE_ASSET} AND ${scope}) AS assets,
                ${subs ? `(SELECT count(*)::int FROM subscription_assignments sa JOIN subscriptions s ON s.id = sa.subscription_id
                  WHERE sa.user_id = u.id AND sa.ended_at IS NULL AND s.status IN ('ACTIVE','TRIAL'))` : '0'} AS subscriptions
           FROM users u LEFT JOIN departments d ON d.id = u.department_id
          WHERE ${where.join(' AND ')}`;
    // Count buckets (fixed strings only, so they are safe to put in the SQL).
    const BUCKETS: Record<string, string> = {
      '0': '= 0', '1': '= 1', '2-4': 'BETWEEN 2 AND 4', '5+': '>= 5', '1+': '>= 1',
    };
    const bucketClause = (column: string, raw: string | undefined, allowed: string[]) => {
      const list = filterList(raw);
      if (list.some((b) => !allowed.includes(b))) throw new BadRequestException(`Invalid ${column} filter`);
      return list.length ? `(${list.map((b) => `x.${column} ${BUCKETS[b]}`).join(' OR ')})` : 'TRUE';
    };
    const atLeast = `${bucketClause('assets', p.assets, ['0', '1', '2-4', '5+'])} AND ${bucketClause('subscriptions', p.subscriptions, ['0', '1+'])}`;
    const holdingClause =
      p.holding === 'assets' ? 'x.assets > 0'
        : p.holding === 'subscriptions' ? 'x.subscriptions > 0'
          : p.holding === 'any' ? '(x.assets > 0 OR x.subscriptions > 0)' : 'TRUE';
    // How many people each tab would show with the other filters applied.
    const [counts] = await this.db.query(
      `SELECT count(*)::int AS "all",
              count(*) FILTER (WHERE x.assets > 0 OR x.subscriptions > 0)::int AS "any",
              count(*) FILTER (WHERE x.assets > 0)::int AS assets,
              count(*) FILTER (WHERE x.subscriptions > 0)::int AS subscriptions,
              coalesce(sum(x.assets), 0)::int AS "assetsHeld"
         FROM (${base}) x WHERE ${atLeast}`,
      values,
    );
    const limit = p.limit ?? 50;
    const offset = p.offset ?? 0;
    values.push(limit + 1, offset);
    const rows = await this.db.query(
      `SELECT * FROM (${base}) x
       WHERE ${holdingClause} AND ${atLeast}
       ORDER BY (x.assets + x.subscriptions) DESC, x.display_name
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    // Field permissions for the People page (counts follow "assets" / "subscriptions").
    const { hidden } = await pageRestrictions(this.db, req.user, 'person');
    return {
      items: rows.slice(0, limit).map((r: any) =>
        hideFields(
          {
            id: r.id,
            name: r.display_name,
            email: r.email,
            designation: r.designation,
            employeeCode: r.employee_code,
            department: r.department,
            left: r.left_org,
            hasPhoto: r.has_photo,
            assets: hidden.has('assets') ? null : r.assets,
            subscriptions: hidden.has('subscriptions') ? null : r.subscriptions,
          },
          'person',
          new Set([...hidden].filter((f) => f !== 'assets' && f !== 'subscriptions')),
        ),
      ),
      nextOffset: rows.length > limit ? offset + limit : null,
      showsSubscriptions: subs && !hidden.has('subscriptions'),
      counts: {
        all: counts.all,
        any: counts.any,
        assets: hidden.has('assets') ? null : counts.assets,
        subscriptions: subs && !hidden.has('subscriptions') ? counts.subscriptions : null,
        assetsHeld: hidden.has('assets') ? null : counts.assetsHeld,
      },
    };
  }

  async profile(req: AuthRequest, id: string) {
    const userId = parse(uuid, id);
    const self = userId === req.user.id;
    if (!self && !canBrowsePeople(req.user)) throw new ForbiddenException('Insufficient permission');
    const [person] = await this.db.query(
      `SELECT u.id, u.display_name, u.email, u.designation, u.employee_code, u.state, u.left_at, u.manager_name,
              d.name AS department, u.department_id,
              EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id = u.id) AS has_photo
         FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1`,
      [userId],
    );
    if (!person) throw new NotFoundException('Person not found');

    // Their own page shows everything they hold; others see assets in their own scope.
    const values: unknown[] = [userId];
    const scope = self ? 'TRUE' : assetScope(req.user, values);
    const money = can(req.user, 'asset.view_private');
    const subs = self || canViewSubscriptions(req.user);
    const staff = can(req.user, 'ticket.work') || can(req.user, 'report.view');
    const fx = await inrRates(this.db);

    const [current, past, subscriptions, tickets] = await Promise.all([
      this.db.query(
        `SELECT a.id, a.asset_code, a.description, a.category, a.asset_type, a.manufacturer, a.model, a.serial_number,
                a.status, a.warranty_expiry, a.purchase_cost, a.currency, g.assigned_at, g.acknowledgement,
                EXISTS(SELECT 1 FROM asset_photos ph WHERE ph.asset_id = a.id) AS has_photo
           FROM assignments g JOIN assets a ON a.id = g.asset_id
          WHERE g.user_id = $1 AND g.ended_at IS NULL AND ${LIVE_ASSET} AND ${scope}
          ORDER BY g.assigned_at DESC`,
        values,
      ),
      this.db.query(
        `SELECT a.id, a.asset_code, a.description, a.asset_type, g.assigned_at, g.ended_at
           FROM assignments g JOIN assets a ON a.id = g.asset_id
          WHERE g.user_id = $1 AND g.ended_at IS NOT NULL AND ${scope}
          ORDER BY g.ended_at DESC LIMIT 50`,
        values,
      ),
      subs
        ? this.db.query(
            `SELECT s.id, s.name, s.vendor, s.plan, s.category, s.status, s.renewal_date, s.cost, s.currency,
                    s.billing_cycle, s.seats_total, s.website, s.logo_fetched_at, sa.assigned_at,
                    CASE WHEN sa.id IS NOT NULL THEN 'PERSON' ELSE s.audience END AS via
               FROM subscriptions s
               LEFT JOIN subscription_assignments sa ON sa.subscription_id = s.id AND sa.user_id = $1 AND sa.ended_at IS NULL
              WHERE sa.id IS NOT NULL
                 OR (s.status IN ('ACTIVE','TRIAL') AND (s.audience = 'ORGANISATION'
                     OR (s.audience = 'DEPARTMENT' AND s.department_id IS NOT NULL AND s.department_id = $2)))
              ORDER BY CASE WHEN sa.id IS NOT NULL THEN 0 ELSE 1 END, s.name`,
            [userId, person.department_id],
          )
        : Promise.resolve([]),
      staff || self
        ? this.db.query(
            `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.created_at
               FROM tickets t WHERE t.reporter_id = $1 ORDER BY t.created_at DESC LIMIT 10`,
            [userId],
          )
        : Promise.resolve([]),
    ]);

    const monthly = (cost: number, cycle: string) =>
      ({ MONTHLY: cost, QUARTERLY: cost / 3, HALF_YEARLY: cost / 6, YEARLY: cost / 12 })[cycle] ?? 0;
    const subscriptionRows = subscriptions.map((s: any) => {
      const cost = s.cost != null ? Number(s.cost) : null;
      // A named seat's share of the plan: monthly cost divided by its seats (unknown if unlimited).
      const share = s.via === 'PERSON' && cost != null && s.seats_total ? monthly(cost, s.billing_cycle) / s.seats_total : null;
      return {
        id: s.id,
        name: s.name,
        vendor: s.vendor,
        plan: s.plan,
        category: s.category,
        status: s.status,
        renewalDate: s.renewal_date,
        via: s.via,
        assignedAt: s.assigned_at,
        logoVersion: s.website ? (s.logo_fetched_at ? new Date(s.logo_fetched_at).getTime() : 0) : null,
        monthlyShareInr: money ? toInr(share, s.currency, fx.rates) : null,
      };
    });
    const assetValue = money ? current.reduce((sum: number, a: any) => sum + (toInr(a.purchase_cost != null ? Number(a.purchase_cost) : null, a.currency ?? 'INR', fx.rates) ?? 0), 0) : null;

    // Field permissions for the People page; a person's own page is never limited.
    const hidden = self ? new Set<string>() : (await pageRestrictions(this.db, req.user, 'person')).hidden;
    const noAssets = hidden.has('assets');
    const noSubs = hidden.has('subscriptions');
    const result = {
      person: {
        id: person.id,
        name: person.display_name,
        email: person.email,
        designation: person.designation,
        employeeCode: person.employee_code,
        department: person.department,
        manager: person.manager_name,
        state: person.state,
        leftAt: person.left_at,
        hasPhoto: person.has_photo,
      },
      totals: {
        assets: noAssets ? 0 : current.length,
        assetValue: noAssets ? null : assetValue,
        pendingConfirmation: noAssets ? 0 : current.filter((a: any) => a.acknowledgement === 'PENDING').length,
        subscriptions: subs && !noSubs ? subscriptionRows.length : null,
        namedSubscriptions: subs && !noSubs ? subscriptionRows.filter((s) => s.via === 'PERSON').length : null,
        monthlySubscriptionShare: money && !noSubs ? subscriptionRows.reduce((sum, s) => sum + (s.monthlyShareInr ?? 0), 0) : null,
        pastAssets: noAssets ? 0 : past.length,
      },
      assets: current.map((a: any) => ({
        id: a.id,
        assetCode: a.asset_code,
        description: a.description,
        category: a.category,
        assetType: a.asset_type,
        manufacturer: a.manufacturer,
        model: a.model,
        serialNumber: a.serial_number,
        status: a.status,
        warrantyExpiry: a.warranty_expiry,
        purchaseCost: money && a.purchase_cost != null ? Number(a.purchase_cost) : null,
        assignedAt: a.assigned_at,
        acknowledgement: a.acknowledgement,
        hasPhoto: a.has_photo,
      })),
      pastAssets: past.map((a: any) => ({
        id: a.id,
        assetCode: a.asset_code,
        description: a.description,
        assetType: a.asset_type,
        assignedAt: a.assigned_at,
        endedAt: a.ended_at,
      })),
      subscriptions: subs ? subscriptionRows : null,
      tickets: staff || self
        ? tickets.map((t: any) => ({
            id: t.id,
            ticketNumber: Number(t.ticket_number),
            subject: t.subject,
            status: t.status,
            priority: t.priority,
            createdAt: t.created_at,
          }))
        : null,
      scopeNote: self || assetScope(req.user, []) === 'TRUE' ? null : 'Showing assets owned by your team only.',
    };
    hideFields(result.person, 'person', hidden);
    return hideFields(result, 'person', hidden);
  }
}

@Controller('people')
@UseGuards(SessionGuard)
export class PersonProfileController {
  constructor(@Inject(PersonProfileService) private readonly service: PersonProfileService) {}

  @Get()
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.list(req, query);
  }
  @Get(':id')
  profile(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.profile(req, id);
  }
}
