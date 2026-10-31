BEGIN;

-- Configurable location levels, outermost first (Site > Zone > ... > Rack).
CREATE TABLE location_levels(
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{1,29}$'),
  label text NOT NULL,
  sort_order int NOT NULL UNIQUE CHECK (sort_order > 0),
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO location_levels(code,label,sort_order) VALUES
  ('SITE','Site',10),
  ('ZONE','Zone',20),
  ('BUILDING','Building',30),
  ('FLOOR','Floor',40),
  ('UNIT','Unit / Room',50),
  ('STORE','Store',60),
  ('RACK','Rack',70);

-- Tree columns. Old site/building/floor/room columns stay for imports and history.
ALTER TABLE locations
  ADD COLUMN parent_id uuid REFERENCES locations(id),
  ADD COLUMN level text REFERENCES location_levels(code),
  ADD COLUMN name text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 150);

-- Existing flat rows become top-level nodes named after their most specific part.
UPDATE locations SET
  level = CASE
    WHEN nullif(btrim(room),'') IS NOT NULL THEN 'UNIT'
    WHEN nullif(btrim(floor),'') IS NOT NULL THEN 'FLOOR'
    WHEN nullif(btrim(building),'') IS NOT NULL THEN 'BUILDING'
    ELSE 'SITE' END,
  name = coalesce(nullif(btrim(room),''), nullif(btrim(floor),''), nullif(btrim(building),''),
                  nullif(btrim(site),''), code);
ALTER TABLE locations ALTER COLUMN level SET NOT NULL, ALTER COLUMN name SET NOT NULL;
CREATE INDEX locations_parent ON locations(parent_id);

-- Guards every writer: a parent must be an outer level, and a node can never sit under itself.
CREATE FUNCTION locations_tree_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE own int; outer_order int; cursor_id uuid; depth int := 0;
BEGIN
  -- Older writers (flat Master Control form, Excel import) send only site/building/floor/room.
  IF NEW.level IS NULL THEN
    NEW.level := CASE
      WHEN nullif(btrim(NEW.room),'') IS NOT NULL THEN 'UNIT'
      WHEN nullif(btrim(NEW.floor),'') IS NOT NULL THEN 'FLOOR'
      WHEN nullif(btrim(NEW.building),'') IS NOT NULL THEN 'BUILDING'
      ELSE 'SITE' END;
  END IF;
  IF NEW.name IS NULL THEN
    NEW.name := coalesce(nullif(btrim(NEW.room),''), nullif(btrim(NEW.floor),''),
                         nullif(btrim(NEW.building),''), nullif(btrim(NEW.site),''), NEW.code);
  END IF;
  SELECT sort_order INTO own FROM location_levels WHERE code = NEW.level;
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'A location cannot be its own parent' USING ERRCODE = '23514';
    END IF;
    SELECT l.sort_order INTO outer_order FROM locations p JOIN location_levels l ON l.code = p.level
      WHERE p.id = NEW.parent_id;
    IF outer_order >= own THEN
      RAISE EXCEPTION 'A % cannot sit inside a location of the same or a lower level', NEW.level
        USING ERRCODE = '23514';
    END IF;
    cursor_id := NEW.parent_id;
    WHILE cursor_id IS NOT NULL LOOP
      depth := depth + 1;
      IF cursor_id = NEW.id OR depth > 50 THEN
        RAISE EXCEPTION 'Moving this location would create a loop' USING ERRCODE = '23514';
      END IF;
      SELECT parent_id INTO cursor_id FROM locations WHERE id = cursor_id;
    END LOOP;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.level IS DISTINCT FROM OLD.level AND EXISTS (
    SELECT 1 FROM locations c JOIN location_levels l ON l.code = c.level
     WHERE c.parent_id = NEW.id AND l.sort_order <= own) THEN
    RAISE EXCEPTION 'Child locations must stay at an inner level' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER locations_tree_guard BEFORE INSERT OR UPDATE OF parent_id, level ON locations
  FOR EACH ROW EXECUTE FUNCTION locations_tree_guard();

COMMIT;
