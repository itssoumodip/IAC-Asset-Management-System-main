import { Db } from './db';
import { configuration, decrypt } from './config';
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { ZohoSyncService, zohoClientFromEnv } from './zoho';
import { processPendingInvoices } from './invoice-ocr';
const retryMinutes = [1, 5, 15, 60, 360];
export async function dispatchOnce(db: Db): Promise<boolean> {
  const lease = randomUUID();
  const delivery = await db.tx(async (c) => {
    await db.query(
      `UPDATE email_deliveries SET state='DEAD',last_error_code='MAX_ATTEMPTS',leased_until=NULL,lease_token=NULL WHERE attempts>=6 AND state='LEASED' AND leased_until<now()`,
      [],
      c,
    );
    await db.query(
      `UPDATE email_deliveries d SET state='DEAD',last_error_code='EXPIRED' FROM notification_outbox o WHERE d.outbox_id=o.id AND d.state IN ('PENDING','LEASED') AND o.expires_at<now()`,
      [],
      c,
    );
    await db.query(
      `UPDATE notification_outbox o SET payload='{}' WHERE payload<>'{}'::jsonb AND ((expires_at IS NOT NULL AND expires_at<now()) OR NOT EXISTS(SELECT 1 FROM email_deliveries d WHERE d.outbox_id=o.id AND d.state IN ('PENDING','LEASED')))`,
      [],
      c,
    );
    const [row] = await db.query(
      `WITH candidate AS (SELECT id FROM email_deliveries WHERE attempts<6 AND next_attempt_at<=now() AND (state='PENDING' OR (state='LEASED' AND leased_until<now())) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE email_deliveries d SET state='LEASED',attempts=attempts+1,leased_until=now()+interval '2 minutes',lease_token=$1 FROM candidate WHERE d.id=candidate.id RETURNING d.*`,
      [lease],
      c,
    );
    return row;
  });
  if (!delivery) return false;
  const [outbox] = await db.query('SELECT payload FROM notification_outbox WHERE id=$1', [
    delivery.outbox_id,
  ]);
  let accepted = false,
    errorCode = 'SMTP_FAILURE',
    sentMessageId = `<${delivery.id}@iac.portal>`;
  try {
    const data = JSON.parse(decrypt(outbox.payload.ciphertext, 'AUTH_MAIL_ENCRYPTION_KEY'));
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || '127.0.0.1',
      port: Number(process.env.SMTP_PORT || 1025),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: configuration().production,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
        : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    const from = process.env.SMTP_FROM || 'IAC Portal <portal@example.org>';
    const host = from.match(/@([^>\s]+)/)?.[1] || 'iac.portal';
    sentMessageId = `<${delivery.id}@${host}>`;
    const result = await transport.sendMail({
      from,
      to: delivery.recipient,
      subject: data.subject,
      text: data.text,
      messageId: sentMessageId,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    accepted = result.accepted?.length === 1;
    transport.close();
    if (!accepted) errorCode = 'SMTP_REJECTED';
  } catch (error) {
    const code = (error as any)?.code;
    errorCode = ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'EENVELOPE', 'ESOCKET', 'EMESSAGE'].includes(
      code,
    )
      ? code
      : 'SMTP_FAILURE';
  }
  await db.tx(async (c) => {
    const [claimed] = await db.query(
      "SELECT id FROM email_deliveries WHERE id=$1 AND lease_token=$2 AND state='LEASED' FOR UPDATE",
      [delivery.id, lease],
      c,
    );
    if (!claimed) return;
    await db.query(
      'INSERT INTO email_attempts(delivery_id,attempt_number,result_code) VALUES($1,$2,$3)',
      [delivery.id, delivery.attempts, accepted ? 'SMTP_ACCEPTED' : errorCode],
      c,
    );
    if (accepted)
      await db.query(
        `UPDATE email_deliveries SET state='ACCEPTED',accepted_at=now(),provider_message_id=$2,leased_until=NULL,lease_token=NULL,last_error_code=NULL WHERE id=$1`,
        [delivery.id, sentMessageId],
        c,
      );
    else {
      const delay =
        (retryMinutes[delivery.attempts - 1] || 360) * 60 + Math.floor(Math.random() * 20);
      await db.query(
        `UPDATE email_deliveries SET state=$2,next_attempt_at=now()+$3*interval '1 second',last_error_code=$4,leased_until=NULL,lease_token=NULL WHERE id=$1`,
        [delivery.id, delivery.attempts >= 6 ? 'DEAD' : 'PENDING', delay, errorCode],
        c,
      );
    }
    await db.audit(
      c,
      null,
      'EMAIL_DELIVERY',
      delivery.id,
      accepted
        ? 'SMTP_ACCEPTED'
        : delivery.attempts >= 6
          ? 'EMAIL_DEAD_LETTERED'
          : 'EMAIL_RETRY_SCHEDULED',
      { attempt: delivery.attempts, result: accepted ? 'SMTP_ACCEPTED' : errorCode },
    );
  });
  return true;
}
/** True when the Asia/Kolkata wall clock is at or past 02:00 on a day not yet synced. */
export function nightlySyncDue(
  now: Date,
  lastRunDay: string | null,
): { due: boolean; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { due: Number(get('hour')) >= 2 && day !== lastRunDay, day };
}
async function run() {
  const db = new Db();
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  const zoho = new ZohoSyncService(db, zohoClientFromEnv());
  // Seed from the last scheduled run so a restart after 02:00 does not sync twice that day.
  let lastSyncDay: string | null = zoho.configured
    ? ((
        await db.query(
          "SELECT to_char(max(started_at) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day FROM zoho_sync_runs WHERE trigger='SCHEDULED'",
        )
      )[0]?.day ?? null)
    : null;
  try {
    while (!stopping) {
      try {
        if (zoho.configured) {
          const { due, day } = nightlySyncDue(new Date(), lastSyncDay);
          if (due) {
            lastSyncDay = day;
            await zoho
              .run('SCHEDULED')
              .catch(() =>
                process.stderr.write('Zoho nightly sync failed; see Directory & Zoho.\n'),
              );
          }
        }
        const mailed = await dispatchOnce(db);
        const read = await processPendingInvoices(db, undefined, 1);
        if (!mailed && !read) await new Promise((r) => setTimeout(r, 1000));
      } catch {
        process.stderr.write('Email worker cycle failed; retrying.\n');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } finally {
    await db.onModuleDestroy();
  }
}
if (require.main === module) {
  void run().catch(() => {
    process.stderr.write('Email worker could not start.\n');
    process.exitCode = 1;
  });
}
