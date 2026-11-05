BEGIN;

-- Asset change requests: field overwrites by another role require approval
CREATE TABLE asset_change_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  requester_id uuid NOT NULL REFERENCES users(id),
  owner_role text NOT NULL REFERENCES roles(code),
  proposed_changes jsonb NOT NULL DEFAULT '{}',
  reason text NOT NULL CHECK(length(btrim(reason)) >= 1 AND length(btrim(reason)) <= 1000),
  asset_version int NOT NULL CHECK(asset_version > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status = ANY (ARRAY['PENDING','APPROVED','REJECTED'])),
  reviewed_by uuid REFERENCES users(id),
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE INDEX asset_change_requests_asset ON asset_change_requests(asset_id, status, created_at DESC);
CREATE INDEX asset_change_requests_pending ON asset_change_requests(owner_role, status, created_at DESC);

COMMIT;
