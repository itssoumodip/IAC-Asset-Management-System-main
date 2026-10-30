BEGIN;

-- 1. Shared viewing between teams (seeded ADM <-> PRJ)
CREATE TABLE IF NOT EXISTS team_view_grants(
  viewer_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  owner_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_team_id, owner_team_id)
);

INSERT INTO team_view_grants(viewer_team_id, owner_team_id) VALUES
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

-- 2. Asset type owning and handling team mapping
ALTER TABLE asset_type_policies
  ADD COLUMN IF NOT EXISTS owning_team_id uuid REFERENCES teams(id),
  ADD COLUMN IF NOT EXISTS handling_team_id uuid REFERENCES teams(id);

-- Seed standard IT types
INSERT INTO asset_type_policies(asset_type_code, requires_custodian, owning_team_id, handling_team_id)
VALUES
  ('Laptop', true, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('Desktop', true, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('Monitor', true, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('Printer', false, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('Networking', false, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001')
ON CONFLICT (asset_type_code) DO UPDATE SET
  owning_team_id = excluded.owning_team_id,
  handling_team_id = excluded.handling_team_id;

-- Seed standard Admin/Facility types
INSERT INTO asset_type_policies(asset_type_code, requires_custodian, owning_team_id, handling_team_id)
VALUES
  ('Chair', false, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'),
  ('Table', false, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'),
  ('Kitchen', false, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'),
  ('Light', false, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002')
ON CONFLICT (asset_type_code) DO UPDATE SET
  owning_team_id = excluded.owning_team_id,
  handling_team_id = excluded.handling_team_id;

COMMIT;
