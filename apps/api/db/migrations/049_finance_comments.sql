BEGIN;

CREATE TABLE finance_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX finance_comments_asset_time ON finance_comments(asset_id, created_at, id);

-- Preserve the existing Finance handoff history as the opening entries in each thread.
INSERT INTO finance_comments(asset_id, author_id, body, created_at)
SELECT e.entity_id,
       e.actor_id,
       CASE e.action
         WHEN 'FINANCE_SUBMITTED' THEN 'Submitted to Finance for review.'
         WHEN 'FINANCE_REJECTED' THEN 'Finance sent this back: ' || COALESCE(NULLIF(e.changes->>'reason', ''), 'No reason recorded.')
         WHEN 'FINANCE_RESUBMITTED' THEN 'Resubmitted to Finance for review.'
         WHEN 'FINANCE_APPROVED' THEN 'Finance approved this submission: ' || COALESCE(NULLIF(e.changes->>'reason', ''), 'Approved.')
         WHEN 'INVOICE_UPLOADED' THEN 'Invoice file uploaded.'
       END,
       e.occurred_at
FROM audit_events e
JOIN assets a ON a.id=e.entity_id
JOIN users u ON u.id=e.actor_id
WHERE e.entity_type='asset'
  AND e.action IN ('FINANCE_SUBMITTED','FINANCE_REJECTED','FINANCE_RESUBMITTED','FINANCE_APPROVED','INVOICE_UPLOADED');

COMMIT;
