-- Precomputed dashboard aggregates (refreshed by the worker) and indexes needed at 100,000+ assets.
CREATE TABLE dashboard_daily(
  scope text PRIMARY KEY,
  payload jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
-- Substring search (ILIKE with a leading wildcard) on the identifiers people actually type.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS assets_asset_code_trgm ON assets USING gin(asset_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_serial_trgm ON assets USING gin(serial_number gin_trgm_ops) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_description_trgm ON assets USING gin(description gin_trgm_ops);
-- Keyset pagination and export order by (asset_code,id).
CREATE INDEX IF NOT EXISTS assets_code_id ON assets(asset_code,id);
CREATE INDEX IF NOT EXISTS assets_department ON assets(department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_category ON assets(category);
CREATE INDEX IF NOT EXISTS tickets_created_at ON tickets(created_at);
CREATE INDEX IF NOT EXISTS tickets_asset ON tickets(asset_id) WHERE asset_id IS NOT NULL;
