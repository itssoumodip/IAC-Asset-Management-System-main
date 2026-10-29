BEGIN;
ALTER TABLE roles DROP CONSTRAINT roles_code_check;
ALTER TABLE roles ADD CONSTRAINT roles_code_check CHECK(code IN ('ADMIN','EMPLOYEE','IT_ADMIN','FINANCE','EXECUTIVE'));
INSERT INTO roles(code) VALUES ('FINANCE'),('EXECUTIVE');
CREATE TABLE asset_finance(
 asset_id uuid PRIMARY KEY REFERENCES assets(id),
 state text NOT NULL CHECK(state IN ('SUBMITTED','RETURNED','APPROVED')),
 version int NOT NULL DEFAULT 1,
 asset_version int NOT NULL,
 submitted_by uuid NOT NULL REFERENCES users(id),submitted_at timestamptz NOT NULL DEFAULT now(),submission_reason text NOT NULL,
 reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,review_reason text,
 approved_cost numeric(14,2) CHECK(approved_cost>=0),approved_purchase_date date,approved_invoice_number text,approved_supplier text,
 approved_at timestamptz,approved_by uuid REFERENCES users(id),
 CHECK((approved_at IS NULL AND approved_by IS NULL AND approved_cost IS NULL) OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approved_cost IS NOT NULL))
);
CREATE INDEX asset_finance_queue ON asset_finance(state,submitted_at,asset_id);
CREATE TABLE asset_finance_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES assets(id),
 action text NOT NULL CHECK(action IN ('SUBMITTED','RETURNED','APPROVED')),
 actor_id uuid NOT NULL REFERENCES users(id),reason text NOT NULL,
 finance_version int NOT NULL,details jsonb NOT NULL DEFAULT '{}',occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_finance_events_asset ON asset_finance_events(asset_id,occurred_at DESC,id DESC);
COMMIT;
