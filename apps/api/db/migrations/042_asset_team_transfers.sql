BEGIN;

-- Team-to-team ownership transfers of an asset. The asset code keeps its original
-- team prefix (assets_code_prefix_check only fires on INSERT and asset_code is
-- immutable), so the prefix records the issuing team, not the current owner.
CREATE TABLE asset_team_transfers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  from_team_id uuid NOT NULL REFERENCES teams(id),
  to_team_id uuid NOT NULL REFERENCES teams(id),
  state text NOT NULL DEFAULT 'REQUESTED'
    CHECK (state IN ('REQUESTED','ACCEPTED','DECLINED','CANCELLED','FORCED')),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) > 0),
  decision_note varchar(1000),
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (to_team_id <> from_team_id),
  CHECK ((state = 'REQUESTED') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX asset_team_transfers_one_open ON asset_team_transfers(asset_id) WHERE state = 'REQUESTED';
CREATE INDEX asset_team_transfers_to ON asset_team_transfers(to_team_id, state, requested_at DESC);
CREATE INDEX asset_team_transfers_from ON asset_team_transfers(from_team_id, state, requested_at DESC);
CREATE INDEX asset_team_transfers_asset ON asset_team_transfers(asset_id, requested_at DESC);

COMMIT;
