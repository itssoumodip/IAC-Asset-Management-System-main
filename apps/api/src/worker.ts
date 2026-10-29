import { Db } from './db';
import { configuration, decrypt } from './config';
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
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
      `UPDATE email_deliveries d SET state='DEAD',leased_until=NULL,lease_token=NULL,last_error_code='EXPIRED' FROM notification_outbox o WHERE d.outbox_id=o.id AND d.state IN ('PENDING','LEASED') AND o.expires_at<now()`,
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
  const [outbox] = await db.query(
    'SELECT payload,template,event_key FROM notification_outbox WHERE id=$1',
    [delivery.outbox_id],
  );
  // A resend or completed authentication flow invalidates its previous link before
  // the original outbox expiry. Never dispatch a link already known to be inactive.
  if (['INVITE', 'VERIFY_EMAIL', 'RESET_PASSWORD', 'EMAIL_CHANGE'].includes(outbox.template)) {
    const [active] = await db.query(
      "SELECT 1 FROM auth_tokens WHERE 'auth:'||id::text=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now()",
      [outbox.event_key, outbox.template],
    );
    if (!active) {
      await db.tx(async (c) => {
        const stopped = await db.query(
          "UPDATE email_deliveries SET state='DEAD',last_error_code='AUTH_TOKEN_INACTIVE',leased_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2 AND state='LEASED' RETURNING id",
          [delivery.id, lease],
          c,
        );
        if (stopped.length)
          await db.audit(c, null, 'EMAIL_DELIVERY', delivery.id, 'EMAIL_AUTH_TOKEN_INACTIVE', {
            template: outbox.template,
          });
      });
      return true;
    }
  }
  if (['FINANCE_SUBMITTED', 'FINANCE_APPROVED', 'FINANCE_RETURNED'].includes(outbox.template)) {
    const role = outbox.template === 'FINANCE_SUBMITTED' ? 'FINANCE' : 'ADMIN';
    const [eligible] = await db.query(
      `SELECT 1 FROM workflow_notifications n JOIN users u ON u.id=n.user_id JOIN user_roles r ON r.user_id=u.id WHERE n.event_key=$3 AND n.kind=$4 AND u.email=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND r.role_code=$2`,
      [
        delivery.recipient,
        role,
        outbox.event_key,
        outbox.template === 'FINANCE_SUBMITTED' ? 'FINANCE_REVIEW' : 'FINANCE_RESULT',
      ],
    );
    if (!eligible) {
      await db.tx(async (c) => {
        await db.query(
          "UPDATE email_deliveries SET state='DEAD',last_error_code='RECIPIENT_INELIGIBLE',leased_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2 AND state='LEASED'",
          [delivery.id, lease],
          c,
        );
        await db.audit(c, null, 'EMAIL_DELIVERY', delivery.id, 'EMAIL_RECIPIENT_INELIGIBLE', {
          template: outbox.template,
        });
      });
      return true;
    }
  }
  if (
    [
      'TICKET_CREATED',
      'TICKET_REPLY',
      'TICKET_OWNER',
      'TICKET_STATUS',
      'TICKET_COMPLETED',
    ].includes(outbox.template)
  ) {
    // Bind the queued address to its original workflow account. Reused email addresses
    // must not inherit another account's pending notification.
    const [eligible] = await db.query(
      `SELECT 1 FROM workflow_notifications n JOIN users u ON u.id=n.user_id JOIN tickets t ON t.id=n.entity_id
       WHERE n.event_key=$1 AND n.kind='TICKET' AND u.email=$2 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
       AND (CASE WHEN $3='TICKET_CREATED' THEN EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='ADMIN')
         WHEN $3='TICKET_OWNER' THEN t.owner_id=u.id AND EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code IN ('ADMIN','IT_ADMIN'))
         ELSE t.reporter_id=u.id OR EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code IN ('ADMIN','IT_ADMIN')) END)`,
      [outbox.event_key, delivery.recipient, outbox.template],
    );
    if (!eligible) {
      await db.tx(async (c) => {
        const stopped = await db.query(
          "UPDATE email_deliveries SET state='DEAD',last_error_code='RECIPIENT_INELIGIBLE',leased_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2 AND state='LEASED' RETURNING id",
          [delivery.id, lease],
          c,
        );
        if (stopped.length)
          await db.audit(c, null, 'EMAIL_DELIVERY', delivery.id, 'EMAIL_RECIPIENT_INELIGIBLE', {
            template: outbox.template,
          });
      });
      return true;
    }
  }
  let accepted = false,
    errorCode = 'SMTP_FAILURE',
    sentMessageId = `<${delivery.id}@iac.portal>`;
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  try {
    const data = JSON.parse(decrypt(outbox.payload.ciphertext, 'AUTH_MAIL_ENCRYPTION_KEY'));
    transport = nodemailer.createTransport({
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
    if (!accepted) errorCode = 'SMTP_REJECTED';
  } catch (error) {
    const code = (error as any)?.code;
    errorCode = ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'EENVELOPE', 'ESOCKET', 'EMESSAGE'].includes(
      code,
    )
      ? code
      : 'SMTP_FAILURE';
  } finally {
    transport?.close();
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
async function run() {
  const db = new Db();
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  try {
    while (!stopping) {
      try {
        if (!(await dispatchOnce(db))) await new Promise((r) => setTimeout(r, 1000));
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
