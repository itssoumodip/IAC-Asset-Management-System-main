import type { PoolClient } from 'pg';
import type { Db } from './db';

/**
 * Puts a freshly registered asset in front of Finance. The asset row is already in the
 * review queue (finance_pending=true => finance_status PENDING, shown as "Submitted"); this
 * records the submission and notifies every active FINANCE user, in-app and by email, through
 * the existing outbox. Runs in the caller's transaction so it commits or rolls back with the
 * asset. Assets without a cost or invoice are still submitted and flagged "missing cost" in the
 * queue (finance.ts derives the flag), because Finance is the one who completes those fields.
 */
export async function submitAssetToFinance(
  db: Db,
  c: PoolClient,
  actor: { id: string },
  asset: { id: string; asset_code: string; description: string; purchase_cost?: string | null },
  via = 'create',
): Promise<void> {
  const missing = asset.purchase_cost == null;
  await db.audit(c, actor as any, 'asset', asset.id, 'FINANCE_SUBMITTED', {
    via,
    missingCost: missing,
  });
  const recipients = (
    await db.query(
      `SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id=u.id
       WHERE r.role_code='FINANCE' AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL`,
      [],
      c,
    )
  ).map((r) => r.email);
  const subject = `Asset ${asset.asset_code} awaits Finance review`;
  const note = missing ? ' Cost is missing; please add it while approving.' : '';
  await db.query(
    `INSERT INTO in_app_announcements(title,message,path,created_by,audience)
     VALUES($1,$2,'/assets',$3,'FINANCE')`,
    [
      subject.slice(0, 100),
      `${asset.description.slice(0, 300)} was registered and needs review.${note}`,
      actor.id,
    ],
    c,
  );
  if (recipients.length)
    await db.notify(c, `finance-submitted:${asset.id}:${via}`, 'finance_submitted', recipients, {
      subject,
      text: `Asset ${asset.asset_code} (${asset.description}) was registered and is waiting in the Finance review queue.${note}\n\nOpen Finance review in the portal to approve or reject it.`,
    });
}
