BEGIN;

-- Location levels: Site, Zone, Building, Floor, Unit/Room, Store, Rack
CREATE TABLE location_levels(
  code text PRIMARY KEY CHECK(code ~ '^[A-Z][A-Z_]{1,29}$'),
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 120),
  sort_order int NOT NULL CHECK(sort_order > 0),
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1 CHECK(version > 0)
);

INSERT INTO location_levels(code,label,sort_order) VALUES
  ('SITE','Site',10),
  ('ZONE','Zone',20),
  ('BUILDING','Building',30),
  ('FLOOR','Floor',40),
  ('UNIT','Unit / Room',50),
  ('STORE','Store',60),
  ('RACK','Rack',70)
ON CONFLICT DO NOTHING;

-- Locations: add parent_id, level, name columns for tree structure
ALTER TABLE locations
  ADD COLUMN parent_id uuid REFERENCES locations(id),
  ADD COLUMN level text NOT NULL DEFAULT 'UNIT' REFERENCES location_levels(code),
  ADD COLUMN name text NOT NULL DEFAULT '';

ALTER TABLE locations
  ADD CONSTRAINT locations_name_check CHECK(name IS NULL OR length(btrim(name)) >= 0 AND length(btrim(name)) <= 150);

CREATE INDEX locations_parent ON locations(parent_id);

-- Trigger to prevent location code changes (codes are permanent)
CREATE OR REPLACE FUNCTION preserve_master_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'location code % is permanent and cannot change', OLD.code USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS location_code_immutable ON locations;
CREATE TRIGGER location_code_immutable BEFORE UPDATE OF code ON locations
  FOR EACH ROW EXECUTE FUNCTION preserve_master_code();

-- Trigger to guard the location tree (prevent cycles, enforce level ordering)
CREATE OR REPLACE FUNCTION locations_tree_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ancestor_count int;
BEGIN
  -- Prevent a location from being its own ancestor (cycle detection)
  WITH RECURSIVE ancestors AS (
    SELECT parent_id FROM locations WHERE id = NEW.id
    UNION ALL
    SELECT l.parent_id FROM locations l JOIN ancestors a ON l.id = a.parent_id
  )
  SELECT count(*) INTO ancestor_count FROM ancestors WHERE parent_id = NEW.id;
  IF ancestor_count > 0 THEN
    RAISE EXCEPTION 'Moving % under % would create a location cycle', NEW.id, NEW.id USING ERRCODE='check_violation';
  END IF;

  -- Enforce level ordering: parent level must sort before child level
  IF NEW.parent_id IS NOT NULL THEN
    DECLARE
      parent_level text;
      parent_order int;
      child_order int;
    BEGIN
      SELECT level, sort_order INTO parent_level, parent_order
      FROM location_levels l JOIN locations p ON p.level = l.code WHERE p.id = NEW.parent_id;
      SELECT sort_order INTO child_order FROM location_levels WHERE code = NEW.level;
      IF parent_order >= child_order THEN
        RAISE EXCEPTION 'Location level % must sort after parent level %', NEW.level, parent_level USING ERRCODE='check_violation';
      END IF;
    END;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER locations_tree_guard BEFORE INSERT OR UPDATE OF parent_id, level ON locations
  FOR EACH ROW EXECUTE FUNCTION locations_tree_guard();

COMMIT;
