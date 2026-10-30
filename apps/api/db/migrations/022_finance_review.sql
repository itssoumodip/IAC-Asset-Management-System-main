-- Finance review state and privately stored invoices with locally extracted fields.
ALTER TABLE assets
  ADD COLUMN finance_status text NOT NULL DEFAULT 'PENDING' CHECK (finance_status IN ('PENDING','APPROVED','REJECTED')),
  ADD COLUMN finance_rejection_reason text,
  ADD COLUMN finance_reviewed_by uuid REFERENCES users(id),
  ADD COLUMN finance_reviewed_at timestamptz;
UPDATE assets SET finance_status = CASE WHEN finance_pending THEN 'PENDING' ELSE 'APPROVED' END;
CREATE INDEX assets_finance_queue ON assets(finance_status, owning_team_id) WHERE finance_status <> 'APPROVED';

-- finance_pending stays in sync with finance_status for existing code and reports.
CREATE FUNCTION sync_finance_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.finance_pending = false AND NEW.finance_status = 'PENDING' THEN NEW.finance_status := 'APPROVED'; END IF;
  ELSIF NEW.finance_status IS DISTINCT FROM OLD.finance_status THEN
    NULL;
  ELSIF NEW.finance_pending IS DISTINCT FROM OLD.finance_pending THEN
    IF NEW.finance_pending THEN
      IF NEW.finance_status = 'APPROVED' THEN NEW.finance_status := 'PENDING'; END IF;
    ELSE
      NEW.finance_status := 'APPROVED';
    END IF;
  END IF;
  NEW.finance_pending := (NEW.finance_status <> 'APPROVED');
  IF NEW.finance_status <> 'REJECTED' THEN NEW.finance_rejection_reason := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_sync_finance_status BEFORE INSERT OR UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION sync_finance_status();

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file bytea NOT NULL,
  mime text NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png')),
  size integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  sha256 text NOT NULL UNIQUE,
  original_name text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  extraction_state text NOT NULL DEFAULT 'PENDING' CHECK (extraction_state IN ('PENDING','DONE','FAILED')),
  extraction_error text,
  extracted_text text,
  extracted_fields jsonb
);
CREATE INDEX invoices_pending ON invoices(uploaded_at) WHERE extraction_state = 'PENDING';
CREATE TABLE invoice_assets (
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  linked_by uuid NOT NULL REFERENCES users(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, asset_id)
);
CREATE INDEX invoice_assets_asset ON invoice_assets(asset_id);
