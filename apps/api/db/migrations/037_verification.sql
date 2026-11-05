BEGIN;

-- Verification cycles and items for auditor verification cycles (P20).
CREATE TABLE verification_cycles(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id text NOT NULL UNIQUE,
  location_id uuid NOT NULL REFERENCES locations(id),
  auditor_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','COMPLETED','CANCELLED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  reason text,
  version int NOT NULL DEFAULT 1
);

CREATE INDEX verification_cycles_location ON verification_cycles(location_id);
CREATE INDEX verification_cycles_auditor ON verification_cycles(auditor_id);
CREATE INDEX verification_cycles_status ON verification_cycles(status);

CREATE TABLE verification_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES verification_cycles(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id),
  expected_location_id uuid NOT NULL REFERENCES locations(id),
  actual_location_id uuid REFERENCES locations(id),
  verification_status text NOT NULL CHECK(verification_status IN ('PENDING','FOUND','NOT_FOUND','WRONG_PLACE')),
  reason text,
  verified_by uuid NOT NULL REFERENCES users(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, asset_id)
);

CREATE INDEX verification_items_cycle ON verification_items(cycle_id);
CREATE INDEX verification_items_asset ON verification_items(asset_id);
CREATE INDEX verification_items_status ON verification_items(verification_status);

COMMIT;
