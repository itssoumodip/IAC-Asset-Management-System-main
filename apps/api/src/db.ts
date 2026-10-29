import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
types.setTypeParser(1082, (value) => value);
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { configuration, encrypt, requestContext } from './config';
import type { Actor } from './security';
@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;
  private readonly transaction = new AsyncLocalStorage<{ client: PoolClient; savepoint: number }>();
  constructor() {
    if (!configuration().databaseUrl) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({
      connectionString: configuration().databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      // Server-side cancellation bounds active work even if the browser disconnects.
      statement_timeout: 30000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 30000,
      ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    this.pool.on('error', () => process.stderr.write('Database pool connection error\n'));
  }
  async query(sql: string, values: any[] = [], client?: PoolClient): Promise<any[]> {
    return (await (client || this.transaction.getStore()?.client || this.pool).query(sql, values))
      .rows;
  }
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const current = this.transaction.getStore();
    if (current) {
      const name = `nested_${++current.savepoint}`;
      await current.client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(current.client);
        await current.client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await current.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await current.client.query(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.transaction.run({ client, savepoint: 0 }, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async audit(
    client: PoolClient,
    actor: Actor | null,
    entityType: string,
    entityId: string | null,
    action: string,
    changes: object = {},
  ): Promise<void> {
    await this.query(
      'INSERT INTO audit_events(actor_id,actor_kind,entity_type,entity_id,action,changes,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor?.id || null,
        actor ? 'USER' : 'SYSTEM',
        entityType,
        entityId,
        action,
        changes,
        actor?.requestId || requestContext.getStore()?.id || randomUUID(),
      ],
      client,
    );
  }
  async notify(
    client: PoolClient,
    eventKey: string,
    template: string,
    recipients: string[],
    data: { subject: string; text: string },
    workflow?: {
      kind: 'TICKET' | 'FINANCE_REVIEW' | 'FINANCE_RESULT';
      entityId: string;
      title: string;
      message: string;
    },
  ): Promise<void> {
    if (workflow)
      await this.workflowNotify(
        client,
        eventKey,
        workflow.kind,
        workflow.entityId,
        recipients,
        workflow.title,
        workflow.message,
      );
    const rows = await this.query(
      'INSERT INTO notification_outbox(event_key,template,payload) VALUES($1,$2,$3) ON CONFLICT(event_key) DO NOTHING RETURNING id',
      [
        eventKey,
        template,
        { ciphertext: encrypt(JSON.stringify(data), 'AUTH_MAIL_ENCRYPTION_KEY') },
      ],
      client,
    );
    if (!rows[0]) return;
    for (const recipient of new Set(recipients.map((v) => v.trim().toLowerCase()))) {
      if (!z.email().max(254).safeParse(recipient).success)
        throw new Error('Invalid notification recipient');
      await this.query(
        'INSERT INTO email_deliveries(outbox_id,recipient) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [rows[0].id, recipient],
        client,
      );
    }
  }
  async workflowNotify(
    client: PoolClient,
    eventKey: string,
    kind: 'ASSIGNMENT' | 'TICKET' | 'FINANCE_REVIEW' | 'FINANCE_RESULT',
    entityId: string,
    recipients: string[],
    title: string,
    message: string,
  ) {
    await this.query(
      `INSERT INTO workflow_notifications(event_key,user_id,kind,entity_id,title,message)
      SELECT $1,u.id,$2,$3,$4,$5 FROM users u WHERE lower(u.email)=ANY($6::text[]) AND u.state IN ('ACTIVE','INVITED')
      ON CONFLICT(event_key,user_id)DO NOTHING`,
      [
        eventKey,
        kind,
        entityId,
        title,
        message,
        [...new Set(recipients.map((v) => v.trim().toLowerCase()))],
      ],
      client,
    );
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
