import {
  ConflictException,
  ForbiddenException,
  Body,
  Controller,
  Header,
  NotFoundException,
  Param,
  StreamableFile,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Optional,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { camel, found, id as uuidOf, parse, text } from './domain-helpers';
import { z } from 'zod';
import { USER_PHOTO, sanitizeImage } from './image-sanitize';
import { assertCan, can } from './policy';
import { AuthRequest, SessionGuard } from './security';

export const ZOHO_CLIENT = 'ZOHO_CLIENT';
const LOCK_KEY = 715031;
const RUN_KEY = 715032;
const PAGE_SIZE = 200;

/** One directory person, normalised from a Zoho People employee record. */
export type MappedPerson = {
  zohoRecordId: string;
  employeeCode: string | null;
  displayName: string;
  email: string;
  department: string | null;
  designation: string | null;
  managerName: string | null;
  status: string | null;
  active: boolean;
  photoRef: string | null;
};

/** The only seam to Zoho; tests inject a stub implementing this. */
export interface ZohoDirectoryClient {
  fetchEmployees(): Promise<Record<string, unknown>[]>;
  /** Downloads the photo a record's Photo field points at; null when none. */
  fetchPhoto?(ref: string): Promise<Buffer | null>;
}

const str = (value: unknown, max = 200): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const v = String(value).trim().slice(0, max);
  return v || null;
};

/** Field names of Zoho's employee form are mapped here and nowhere else. */
export function mapZohoRecord(record: Record<string, unknown>): MappedPerson | null {
  const zohoRecordId = str(record.recordId ?? record.Zoho_ID);
  const email = str(record.EmailID)?.toLowerCase() ?? null;
  if (!zohoRecordId || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = [str(record.FirstName), str(record.LastName)].filter(Boolean).join(' ');
  const status = str(record.Employeestatus, 60);
  return {
    zohoRecordId,
    employeeCode: str(record.EmployeeID, 60),
    displayName: name || email.split('@')[0]!,
    email,
    department: str(record.Department, 120),
    designation: str(record.Designation, 120),
    managerName: str(record.Reporting_To, 200),
    status,
    active: !status || status.toLowerCase() === 'active',
    photoRef: str(record.Photo, 500),
  };
}

export class ZohoClient implements ZohoDirectoryClient {
  private accessToken: { value: string; expires: number } | null = null;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly dc = 'in',
  ) {
    if (!/^[a-z]+(\.[a-z]+)?$/.test(dc)) throw new Error('ZOHO_DC is invalid');
  }
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000)
      return this.accessToken.value;
    const body = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
    });
    const res = await fetch(`https://accounts.zoho.${this.dc}/oauth/v2/token`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token)
      throw new Error(`Zoho token refresh failed (${json.error || res.status})`);
    this.accessToken = {
      value: json.access_token,
      expires: Date.now() + Number(json.expires_in || 3600) * 1000,
    };
    return this.accessToken.value;
  }
  /** The Photo field is either a download URL on this data centre or a Zoho file id. */
  async fetchPhoto(ref: string): Promise<Buffer | null> {
    let url: string;
    if (/^https:\/\//i.test(ref)) {
      const u = new URL(ref);
      if (u.hostname !== `people.zoho.${this.dc}`)
        throw new Error('Photo URL is not on the Zoho People host');
      url = u.toString();
    } else
      url = `https://people.zoho.${this.dc}/api/v2/files/download?fileId=${encodeURIComponent(ref)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${await this.token()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Zoho photo download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length ? bytes : null;
  }
  async fetchEmployees(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let index = 1; ; index += PAGE_SIZE) {
      const url = `https://people.zoho.${this.dc}/people/api/forms/employee/getRecords?sIndex=${index}&limit=${PAGE_SIZE}`;
      const res = await fetch(url, {
        headers: { Authorization: `Zoho-oauthtoken ${await this.token()}` },
        signal: AbortSignal.timeout(30_000),
      });
      const json: any = await res.json().catch(() => ({}));
      const result = json?.response?.result;
      if (!res.ok || !Array.isArray(result)) {
        // Zoho answers a page past the last record with an error body; stop only if we already have data.
        if (out.length && json?.response?.errors) break;
        throw new Error(`Zoho getRecords failed (${res.status})`);
      }
      let count = 0;
      for (const entry of result)
        for (const [recordId, rows] of Object.entries(entry as Record<string, unknown>))
          for (const row of Array.isArray(rows) ? rows : []) {
            out.push({ ...(row as object), recordId });
            count++;
          }
      if (count < PAGE_SIZE) break;
    }
    return out;
  }
}

export function zohoClientFromEnv(): ZohoClient | null {
  const {
    ZOHO_CLIENT_ID: id,
    ZOHO_CLIENT_SECRET: secret,
    ZOHO_REFRESH_TOKEN: refresh,
  } = process.env;
  if (!id || !secret || !refresh) return null;
  return new ZohoClient(id, secret, refresh, process.env.ZOHO_DC || 'in');
}

const departmentCode = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 12) || 'DEPT';

@Injectable()
export class ZohoSyncService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Optional() @Inject(ZOHO_CLIENT) private readonly client: ZohoDirectoryClient | null = null,
  ) {}

  get configured() {
    return !!this.client;
  }

  async status(req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    const runs = await this.db.query(
      'SELECT id,trigger,started_at,finished_at,status,created_count,updated_count,left_count,skipped_count,error FROM zoho_sync_runs ORDER BY started_at DESC,id LIMIT 10',
    );
    return {
      configured: this.configured,
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status,
        created: r.created_count,
        updated: r.updated_count,
        left: r.left_count,
        skipped: r.skipped_count,
        error: r.error,
      })),
    };
  }

  async recover(req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    const rows = await this.db.query(
      `SELECT u.id AS user_id,u.display_name,u.email,u.employee_code,u.state,u.left_at,
              a.id AS asset_id,a.asset_code,a.description,s.assigned_at,
              EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id=u.id) AS has_photo
       FROM users u JOIN assignments s ON s.user_id=u.id AND s.ended_at IS NULL
       JOIN assets a ON a.id=s.asset_id
       WHERE u.left_at IS NOT NULL ORDER BY u.left_at DESC,u.display_name,a.asset_code`,
    );
    return { items: rows.map(camel) };
  }

  /**
   * Downloads and sanitises a record's photo OUTSIDE any transaction. Never throws; null when
   * there is nothing to store (no ref, unchanged ref with a stored photo, or any failure).
   */
  private async preparePhoto(p: MappedPerson) {
    if (!p.photoRef || !this.client?.fetchPhoto) return null;
    try {
      const [known] = await this.db.query(
        `SELECT u.zoho_photo_ref,EXISTS(SELECT 1 FROM user_photos x WHERE x.user_id=u.id) AS has_photo
         FROM users u WHERE u.zoho_record_id=$1 OR u.email=$2 ORDER BY (u.zoho_record_id=$1) DESC LIMIT 1`,
        [p.zohoRecordId, p.email],
      );
      if (known && known.zoho_photo_ref === p.photoRef && known.has_photo) return null;
      const bytes = await this.client.fetchPhoto(p.photoRef);
      if (!bytes) return null;
      const mime = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpeg' : 'png';
      const { content, sha256 } = await sanitizeImage(
        `data:image/${mime};base64,${bytes.toString('base64')}`,
        USER_PHOTO,
      );
      return { ref: p.photoRef, content, sha256 };
    } catch (error) {
      process.stderr.write(
        `Zoho photo skipped for ${p.zohoRecordId}: ${String((error as Error)?.message).slice(0, 120)}\n`,
      );
      return null;
    }
  }

  /** Writes a prepared photo inside a savepoint so a failed write never aborts the record. */
  private async storePhoto(
    c: PoolClient,
    userId: string,
    photo: { ref: string; content: Buffer; sha256: string } | null,
  ) {
    if (!photo) return;
    await c.query('SAVEPOINT zoho_photo');
    try {
      await c.query(
        `INSERT INTO user_photos(user_id,content,sha256) VALUES($1,$2,$3)
         ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,sha256=excluded.sha256,updated_at=now()`,
        [userId, photo.content, photo.sha256],
      );
      await c.query('UPDATE users SET zoho_photo_ref=$2 WHERE id=$1', [userId, photo.ref]);
      await c.query('RELEASE SAVEPOINT zoho_photo');
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT zoho_photo');
      await c.query('RELEASE SAVEPOINT zoho_photo');
      process.stderr.write(
        `Zoho photo not stored for ${userId}: ${String((error as Error)?.message).slice(0, 120)}\n`,
      );
    }
  }

  async photo(req: AuthRequest, userId: string) {
    uuidOf(userId);
    if (req.user.id !== userId && !can(req.user, 'ticket.work') && !can(req.user, 'asset.view_all'))
      throw new ForbiddenException('Insufficient permission');
    const [row] = await this.db.query('SELECT content FROM user_photos WHERE user_id=$1', [userId]);
    if (!row) throw new NotFoundException();
    return { content: row.content as Buffer };
  }

  async unmatched(req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    const cols = `u.id,u.email,u.display_name,u.employee_code,u.zoho_record_id,u.state,u.designation,u.left_at,
      EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id=u.id) AS has_photo,
      (SELECT count(*)::int FROM assignments s WHERE s.user_id=u.id AND s.ended_at IS NULL) AS assets_held`;
    const zoho = await this.db.query(
      `SELECT ${cols} FROM users u WHERE u.state='DIRECTORY' AND u.zoho_record_id IS NOT NULL ORDER BY u.display_name LIMIT 500`,
    );
    const accounts = await this.db.query(
      `SELECT ${cols} FROM users u WHERE u.state IN ('ACTIVE','INVITED') AND u.zoho_record_id IS NULL ORDER BY u.display_name LIMIT 500`,
    );
    const blocked = await this.db.query(
      `SELECT ${cols},u.zoho_unlinked_record_id FROM users u WHERE u.zoho_unlinked_record_id IS NOT NULL AND u.zoho_record_id IS NULL AND u.merged_into_user_id IS NULL ORDER BY u.display_name LIMIT 500`,
    );
    return {
      zohoWithoutAccount: zoho.map(camel),
      accountsWithoutZoho: accounts.map(camel),
      blockedByUnlink: blocked.map(camel),
    };
  }

  /** Attaches a synced Zoho record to a portal account and removes the directory duplicate. */
  async link(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const data = parse(
      z.object({ userId: z.string().uuid(), zohoRecordId: text(200), reason: text(1000) }).strict(),
      body,
    );
    return this.db.tx(async (c) => {
      await this.db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY], c);
      const target = found(
        (await this.db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [data.userId], c))[0],
      );
      if (target.state === 'DIRECTORY' || target.zoho_record_id)
        throw new ConflictException('This account is already linked to a Zoho record');
      if (target.state === 'DISABLED' || target.merged_into_user_id)
        throw new ConflictException('A disabled or merged account cannot be linked to Zoho');
      const dup = (
        await this.db.query(
          'SELECT * FROM users WHERE zoho_record_id=$1 FOR UPDATE',
          [data.zohoRecordId],
          c,
        )
      )[0];
      if (!dup) throw new NotFoundException('No synced Zoho record with that id; run a sync first');
      if (dup.state !== 'DIRECTORY')
        throw new ConflictException('That Zoho record is already linked to a portal account');
      const [{ n }] = await this.db.query(
        `SELECT (SELECT count(*) FROM assignments WHERE user_id=$1 AND ended_at IS NULL)+(SELECT count(*) FROM team_memberships WHERE user_id=$1) AS n`,
        [dup.id],
        c,
      );
      if (Number(n) > 0)
        throw new ConflictException(
          'The Zoho directory entry still holds assets or team memberships; return or transfer them first',
        );
      // Ended assignments and reported tickets are history: move them to the kept account.
      const moved = await this.db.query(
        'UPDATE assignments SET user_id=$2 WHERE user_id=$1 RETURNING id',
        [dup.id, target.id],
        c,
      );
      const reported = await this.db.query(
        'UPDATE tickets SET reporter_id=$2 WHERE reporter_id=$1 RETURNING id',
        [dup.id, target.id],
        c,
      );
      await this.db.query(
        `INSERT INTO user_photos(user_id,content,sha256) SELECT $2,content,sha256 FROM user_photos WHERE user_id=$1
         ON CONFLICT(user_id) DO NOTHING`,
        [dup.id, target.id],
        c,
      );
      await this.db.query('DELETE FROM user_photos WHERE user_id=$1', [dup.id], c);
      await this.db.query('DELETE FROM user_roles WHERE user_id=$1', [dup.id], c);
      // Retire the duplicate in place: the runtime role cannot delete users.
      await this.db.query(
        "UPDATE users SET state='DISABLED',zoho_record_id=NULL,zoho_photo_ref=NULL,merged_into_user_id=$2,updated_at=now(),version=version+1 WHERE id=$1",
        [dup.id, target.id],
        c,
      );
      await this.db.query(
        `UPDATE users SET zoho_record_id=$2,employee_code=$3,manager_name=$4,zoho_status=$5,left_at=$6,zoho_synced_at=$7,zoho_photo_ref=$8,zoho_unlinked_record_id=NULL,
           designation=coalesce(designation,$9),department_id=coalesce(department_id,$10::uuid),updated_at=now(),version=version+1 WHERE id=$1`,
        [
          target.id,
          dup.zoho_record_id,
          dup.employee_code,
          dup.manager_name,
          dup.zoho_status,
          dup.left_at,
          dup.zoho_synced_at,
          dup.zoho_photo_ref,
          dup.designation,
          dup.department_id,
        ],
        c,
      );
      await this.db.audit(c, req.user, 'USER', target.id, 'ZOHO_LINKED', {
        zohoRecordId: data.zohoRecordId,
        removedDirectoryUserId: dup.id,
        movedAssignments: moved.length,
        movedTickets: reported.length,
        reason: data.reason,
      });
      return { id: target.id as string, zohoRecordId: data.zohoRecordId };
    });
  }

  async unlink(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const data = parse(z.object({ userId: z.string().uuid(), reason: text(1000) }).strict(), body);
    return this.db.tx(async (c) => {
      const user = found(
        (await this.db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [data.userId], c))[0],
      );
      if (user.state === 'DIRECTORY')
        throw new ConflictException('Directory-only people are managed by the sync');
      if (!user.zoho_record_id) throw new ConflictException('This account is not linked to Zoho');
      await this.db.query(
        'UPDATE users SET zoho_record_id=NULL,employee_code=NULL,manager_name=NULL,zoho_status=NULL,left_at=NULL,zoho_synced_at=NULL,zoho_photo_ref=NULL,zoho_unlinked_record_id=$2,updated_at=now(),version=version+1 WHERE id=$1',
        [user.id, user.zoho_record_id],
        c,
      );
      await this.db.audit(c, req.user, 'USER', user.id, 'ZOHO_UNLINKED', {
        zohoRecordId: user.zoho_record_id,
        reason: data.reason,
      });
      return { id: user.id as string };
    });
  }

  /**
   * Runs one sync. Throws 409 when unconfigured or another run is active. The Zoho fetch and photo
   * downloads happen outside any transaction; each record is then applied in its own short one.
   */
  async run(trigger: 'SCHEDULED' | 'MANUAL', actor: AuthRequest['user'] | null = null) {
    const client = this.client;
    if (!client) throw new ConflictException('Zoho People sync is not configured');
    const started = new Date();
    const guard = await this.db.pool.connect();
    let locked = false;
    let broken = false;
    try {
      const { rows } = await guard.query('SELECT pg_try_advisory_lock($1) AS ok', [RUN_KEY]);
      if (!rows[0].ok) throw new ConflictException('A Zoho sync is already running');
      locked = true;
      const records = await client.fetchEmployees();
      return await this.apply(records, trigger, actor, started);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      await this.db.query(
        "INSERT INTO zoho_sync_runs(trigger,started_at,finished_at,status,error,started_by) VALUES($1,$2,now(),'FAILED',$3,$4)",
        [
          trigger,
          started,
          String((error as Error)?.message || error).slice(0, 500),
          actor?.id ?? null,
        ],
      );
      throw error;
    } finally {
      if (locked)
        try {
          await guard.query('SELECT pg_advisory_unlock($1)', [RUN_KEY]);
        } catch {
          broken = true;
        }
      guard.release(broken || undefined);
    }
  }

  private async department(c: PoolClient, name: string) {
    const key = name.toLowerCase();
    const [existing] = await this.db.query(
      'SELECT id FROM departments WHERE lower(name)=$1',
      [key],
      c,
    );
    let id = existing?.id as string | undefined;
    if (!id) {
      const base = departmentCode(name);
      for (let n = 0; !id; n++) {
        const code = n === 0 ? base : `${base.slice(0, 10)}${n + 1}`;
        const [row] = await this.db.query(
          'INSERT INTO departments(code,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
          [code, name],
          c,
        );
        id = row?.id;
      }
    }
    return id!;
  }

  private async apply(
    records: Record<string, unknown>[],
    trigger: string,
    actor: AuthRequest['user'] | null,
    started: Date,
  ) {
    let created = 0,
      updated = 0,
      left = 0,
      skipped = 0,
      errors = 0,
      firstError = '';
    const newlyLeft: string[] = [];
    for (const record of records) {
      const p = mapZohoRecord(record);
      if (!p) {
        skipped++;
        continue;
      }
      try {
        const photo = await this.preparePhoto(p);
        const outcome = await this.db.tx(async (c) => {
          await this.db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY], c);
          return this.applyOne(c, p, photo);
        });
        if (outcome.kind === 'skipped') skipped++;
        else if (outcome.kind === 'created') created++;
        else {
          updated++;
          if (outcome.nowLeft) {
            left++;
            newlyLeft.push(outcome.userId);
          }
        }
      } catch (error) {
        errors++;
        skipped++;
        firstError ||= String((error as Error)?.message || error).slice(0, 200);
        process.stderr.write(
          `Zoho record ${p.zohoRecordId} not applied: ${String((error as Error)?.message).slice(0, 120)}\n`,
        );
      }
    }
    return this.db.tx(async (c) => {
      const [run] = await this.db.query(
        "INSERT INTO zoho_sync_runs(trigger,started_at,finished_at,status,created_count,updated_count,left_count,skipped_count,error,started_by) VALUES($1,$2,now(),'SUCCEEDED',$3,$4,$5,$6,$7,$8) RETURNING id",
        [
          trigger,
          started,
          created,
          updated,
          left,
          skipped,
          errors ? `${errors} record(s) failed to apply; first: ${firstError}` : null,
          actor?.id ?? null,
        ],
        c,
      );
      if (newlyLeft.length) await this.digest(c, run.id, newlyLeft);
      await this.db.audit(c, actor ?? null, 'ZOHO_SYNC', run.id, 'ZOHO_SYNC_COMPLETED', {
        trigger,
        created,
        updated,
        left,
        skipped,
        errors,
      });
      return { id: run.id as string, created, updated, left, skipped, errors };
    });
  }

  private async applyOne(
    c: PoolClient,
    p: MappedPerson,
    photo: { ref: string; content: Buffer; sha256: string } | null,
  ): Promise<
    | { kind: 'skipped' }
    | { kind: 'created'; userId: string }
    | { kind: 'updated'; userId: string; nowLeft: boolean }
  > {
    let [user] = await this.db.query(
      'SELECT * FROM users WHERE zoho_record_id=$1 FOR UPDATE',
      [p.zohoRecordId],
      c,
    );
    if (!user) {
      [user] = await this.db.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [p.email], c);
      if (
        user &&
        ((user.zoho_record_id && user.zoho_record_id !== p.zohoRecordId) ||
          user.merged_into_user_id ||
          user.zoho_unlinked_record_id === p.zohoRecordId)
      )
        return { kind: 'skipped' };
    }
    if (!user && !p.active) return { kind: 'skipped' };
    const departmentId = p.department ? await this.department(c, p.department) : null;
    if (!user) {
      const [row] = await this.db.query(
        `INSERT INTO users(email,display_name,state,designation,department_id,zoho_record_id,employee_code,manager_name,zoho_status,zoho_synced_at)
         VALUES($1,$2,'DIRECTORY',$3,$4,$5,$6,$7,$8,now()) RETURNING id`,
        [
          p.email,
          p.displayName,
          p.designation,
          departmentId,
          p.zohoRecordId,
          p.employeeCode,
          p.managerName,
          p.status,
        ],
        c,
      );
      await this.db.query(
        "INSERT INTO user_roles(user_id,role_code) VALUES($1,'EMPLOYEE')",
        [row.id],
        c,
      );
      await this.storePhoto(c, row.id, photo);
      return { kind: 'created', userId: row.id };
    }
    const directory = user.state === 'DIRECTORY';
    const nowLeft = !p.active && !user.left_at;
    await this.db.query(
      `UPDATE users SET zoho_record_id=$2,employee_code=$3,manager_name=$4,zoho_status=$5,zoho_synced_at=now(),
         left_at=CASE WHEN $6::boolean THEN coalesce(left_at,now()) ELSE NULL END,
         display_name=CASE WHEN $7::boolean THEN $8 ELSE display_name END,
         designation=CASE WHEN $7::boolean THEN coalesce($9,designation) ELSE coalesce(designation,$9) END,
         department_id=CASE WHEN $7::boolean THEN coalesce($10::uuid,department_id) ELSE coalesce(department_id,$10::uuid) END
       WHERE id=$1`,
      [
        user.id,
        p.zohoRecordId,
        p.employeeCode,
        p.managerName,
        p.status,
        !p.active,
        directory,
        p.displayName,
        p.designation,
        departmentId,
      ],
      c,
    );
    await this.storePhoto(c, user.id, photo);
    return { kind: 'updated', userId: user.id, nowLeft };
  }

  /** One email to Super Admins listing newly detected leavers who still hold assets. */
  private async digest(c: PoolClient, runId: string, userIds: string[]) {
    const held = await this.db.query(
      `SELECT u.display_name,u.email,u.state,a.asset_code,a.description
       FROM users u JOIN assignments s ON s.user_id=u.id AND s.ended_at IS NULL JOIN assets a ON a.id=s.asset_id
       WHERE u.id=ANY($1::uuid[]) ORDER BY u.display_name,a.asset_code`,
      [userIds],
      c,
    );
    if (!held.length) return;
    const recipients = (
      await this.db.query(
        `SELECT DISTINCT u.email FROM users u WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
         AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='SUPER_ADMIN')`,
        [],
        c,
      )
    ).map((r) => r.email);
    const lines = held.map((h) =>
      `- ${h.display_name} <${h.email}>: ${h.asset_code} ${h.description || ''}`.trimEnd(),
    );
    const portal = held.some((h) => h.state === 'ACTIVE')
      ? '\n\nSome of these people have portal accounts. Their accounts were not disabled automatically; review them in People & access.'
      : '';
    await this.db.notify(c, `zoho:leavers:${runId}`, 'ZOHO_LEAVERS', recipients, {
      subject: 'IAC assets to recover from people who left',
      text: `Zoho People reports these people have left but still hold assets:\n\n${lines.join('\n')}${portal}\n\nOpen Directory & Zoho in the IAC Asset portal to see the full To recover list. Nothing has been returned automatically.`,
    });
  }
}

@Controller('directory')
@UseGuards(SessionGuard)
export class DirectoryController {
  constructor(@Inject(ZohoSyncService) private readonly service: ZohoSyncService) {}

  @Get('sync')
  status(@Req() req: AuthRequest) {
    return this.service.status(req);
  }

  @Post('sync')
  @HttpCode(200)
  async sync(@Req() req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    return this.service.run('MANUAL', req.user);
  }

  @Get('recover')
  recover(@Req() req: AuthRequest) {
    return this.service.recover(req);
  }

  @Get('unmatched')
  unmatched(@Req() req: AuthRequest) {
    return this.service.unmatched(req);
  }

  @Post('link')
  @HttpCode(200)
  link(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.link(req, body);
  }

  @Post('unlink')
  @HttpCode(200)
  unlink(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.unlink(req, body);
  }
}

@Controller('users')
@UseGuards(SessionGuard)
export class UserPhotoController {
  constructor(@Inject(ZohoSyncService) private readonly service: ZohoSyncService) {}

  @Get(':id/photo')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'private, max-age=300')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(@Req() req: AuthRequest, @Param('id') userId: string) {
    return new StreamableFile((await this.service.photo(req, userId)).content);
  }
}
