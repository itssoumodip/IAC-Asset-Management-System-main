BEGIN;
-- Asset kits: a part (charger, bag) hangs off one parent asset and moves with it.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS parent_asset_id uuid REFERENCES assets(id);
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_parent_not_self;
ALTER TABLE assets ADD CONSTRAINT assets_parent_not_self CHECK (parent_asset_id IS NULL OR parent_asset_id <> id);
CREATE INDEX IF NOT EXISTS assets_parent_asset_idx ON assets(parent_asset_id) WHERE parent_asset_id IS NOT NULL;

-- Backstop for the service rules: one level only, same owning team.
CREATE OR REPLACE FUNCTION assets_kit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p assets%ROWTYPE;
BEGIN
  IF NEW.parent_asset_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO p FROM assets WHERE id = NEW.parent_asset_id;
  IF p.parent_asset_id IS NOT NULL THEN RAISE EXCEPTION 'A kit part cannot be a parent' USING ERRCODE='23514'; END IF;
  IF p.owning_team_id IS DISTINCT FROM NEW.owning_team_id THEN RAISE EXCEPTION 'Kit parent and part must share an owning team' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM assets WHERE parent_asset_id = NEW.id) THEN RAISE EXCEPTION 'A kit parent cannot become a part' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assets_kit_guard_trg ON assets;
CREATE TRIGGER assets_kit_guard_trg BEFORE INSERT OR UPDATE OF parent_asset_id, owning_team_id ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_kit_guard();
COMMIT;
