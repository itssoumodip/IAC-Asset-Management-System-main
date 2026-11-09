BEGIN;

-- Minimum in-store level per product type (category + asset type), optionally per owning team.
-- owning_team_id NULL = default level that applies to every team without its own row.
CREATE TABLE IF NOT EXISTS inventory_min_stock(
  category text NOT NULL CHECK(length(btrim(category)) BETWEEN 1 AND 200),
  asset_type text NOT NULL DEFAULT '' CHECK(length(asset_type) <= 200),
  owning_team_id uuid REFERENCES teams(id),
  min_in_store int NOT NULL CHECK(min_in_store >= 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- NULL team ids never collide in a plain UNIQUE constraint, so coalesce to the nil uuid.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_min_stock_key
  ON inventory_min_stock(category, asset_type, COALESCE(owning_team_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMIT;
