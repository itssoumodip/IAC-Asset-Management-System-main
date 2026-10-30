-- Zoho People directory sync: directory-only people (no portal login) and sync run history.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_state_check;
ALTER TABLE users ADD CONSTRAINT users_state_check CHECK(state IN ('INVITED','ACTIVE','DISABLED','DIRECTORY'));
ALTER TABLE users
  ADD COLUMN zoho_record_id text UNIQUE,
  ADD COLUMN employee_code text,
  ADD COLUMN manager_name text,
  ADD COLUMN zoho_status text,
  ADD COLUMN left_at timestamptz,
  ADD COLUMN zoho_synced_at timestamptz;
CREATE TABLE zoho_sync_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK(trigger IN ('SCHEDULED','MANUAL')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),
  created_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  left_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0,
  error text,
  started_by uuid REFERENCES users(id)
);
CREATE INDEX zoho_sync_runs_started ON zoho_sync_runs(started_at DESC);
ALTER TABLE users ADD COLUMN zoho_photo_ref text;
CREATE TABLE user_photos(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content bytea NOT NULL,
  sha256 text NOT NULL,
  source text NOT NULL DEFAULT 'ZOHO' CHECK(source IN ('ZOHO')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users
  ADD COLUMN merged_into_user_id uuid REFERENCES users(id),
  ADD COLUMN zoho_unlinked_record_id text;
