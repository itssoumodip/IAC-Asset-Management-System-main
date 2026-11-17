BEGIN;

-- "Remove from register": a Super Admin can take an asset off the register without erasing it.
-- Removed assets are hidden from lists, dashboards and exports; their record and history stay,
-- and they can be restored. Status is left as it was (a removal is not a write-off).
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS removed_reason text
    CHECK (removed_reason IS NULL OR length(btrim(removed_reason)) BETWEEN 1 AND 1000);

CREATE INDEX IF NOT EXISTS assets_removed ON assets(removed_at) WHERE removed_at IS NOT NULL;

COMMIT;
