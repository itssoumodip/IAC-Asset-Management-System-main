-- Crash-safe invoice extraction: claim (PROCESSING + attempt counter) is committed before the work starts,
-- so a hang or crash cannot loop forever. Stale PROCESSING rows (>10 min) are retried until attempts run out.
ALTER TABLE invoices
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN processing_started_at timestamptz;
ALTER TABLE invoices DROP CONSTRAINT invoices_extraction_state_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_extraction_state_check
  CHECK (extraction_state IN ('PENDING','PROCESSING','DONE','FAILED'));
DROP INDEX invoices_pending;
CREATE INDEX invoices_pending ON invoices(uploaded_at) WHERE extraction_state IN ('PENDING','PROCESSING');
