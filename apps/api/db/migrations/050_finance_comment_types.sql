BEGIN;

ALTER TABLE finance_comments
  ADD COLUMN entry_type text NOT NULL DEFAULT 'COMMENT'
    CHECK (entry_type IN ('COMMENT','EVENT'));

UPDATE finance_comments
SET entry_type='EVENT'
WHERE body IN (
    'Submitted to Finance for review.',
    'Resubmitted to Finance for review.',
    'Invoice file uploaded.'
  )
  OR body LIKE 'Finance sent this back:%'
  OR body LIKE 'Finance approved this submission:%'
  OR body LIKE 'Invoice attached:%';

COMMIT;
