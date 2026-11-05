BEGIN;

-- Add Phase 2 roles: TEAM_LEAD, TEAM_MEMBER, STORE, TECHNICIAN, AUDITOR, INSURER, PROCUREMENT
-- (SUPER_ADMIN, FINANCE, EXECUTIVE, EMPLOYEE already exist from migration 001/017)
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_valid;
DELETE FROM roles WHERE code IN ('ADMIN','IT_ADMIN');

ALTER TABLE roles ADD CONSTRAINT roles_code_valid
  CHECK (code IN ('EMPLOYEE','SUPER_ADMIN','FINANCE','EXECUTIVE','TEAM_LEAD','TEAM_MEMBER','STORE','TECHNICIAN','AUDITOR','INSURER','PROCUREMENT'));

INSERT INTO roles(code) VALUES
  ('TEAM_LEAD'),('TEAM_MEMBER'),('STORE'),('TECHNICIAN'),('AUDITOR'),('INSURER'),('PROCUREMENT')
ON CONFLICT DO NOTHING;

-- asset_type_policies: add owning_team_id and handling_team_id columns
ALTER TABLE asset_type_policies
  ADD COLUMN IF NOT EXISTS owning_team_id uuid REFERENCES teams(id),
  ADD COLUMN IF NOT EXISTS handling_team_id uuid REFERENCES teams(id);

-- assets: add parent_asset_id for kit structure
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS parent_asset_id uuid REFERENCES assets(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_parent_not_self'
  ) THEN
    ALTER TABLE assets
      ADD CONSTRAINT assets_parent_not_self CHECK(parent_asset_id IS NULL OR parent_asset_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assets_parent_asset_idx ON assets(parent_asset_id) WHERE parent_asset_id IS NOT NULL;

COMMIT;
