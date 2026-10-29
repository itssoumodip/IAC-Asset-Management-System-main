BEGIN;
CREATE TABLE finance_invoice_evidence(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES assets(id),
 uploaded_by uuid NOT NULL REFERENCES users(id),filename text NOT NULL,mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 4194304),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 extraction jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(asset_id,sha256)
);
CREATE INDEX finance_invoice_evidence_asset ON finance_invoice_evidence(asset_id,created_at DESC,id);
CREATE TRIGGER immutable_invoice_evidence BEFORE UPDATE OR DELETE ON finance_invoice_evidence FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
