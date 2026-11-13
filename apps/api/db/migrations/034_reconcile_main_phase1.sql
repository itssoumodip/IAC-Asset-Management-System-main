BEGIN;

-- Reconciles two parallel versions of migrations 028-034.
--
-- Both `main` and `feat/role-specific-dashboards` added files named 028..034
-- with different contents. The runner records migrations by file name only,
-- so a database that ran one branch's 028..034 never runs the other's. The
-- merged branch keeps the feature-branch files unchanged (local databases
-- already ran them) and this file brings ANY database to the combined schema:
--   * a database that ran main's 028..034 (runs this before 035)
--   * a database that ran the feature-branch 028..034 (runs this after 048)
--   * a fresh database (runs this right after the feature 034)
-- Every statement is idempotent and safe in any of those orders.
-- File name sorts after 034_category_teams.sql and before 035_*.

-- 1. Restore the shared code-immutability check from 004. The feature 028
--    replaced it with a location-only version, which stopped protecting
--    reference_values.kind and gave departments/reference values a
--    "location code" error message.
CREATE OR REPLACE FUNCTION preserve_master_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.code IS DISTINCT FROM NEW.code OR (TG_TABLE_NAME='reference_values' AND (to_jsonb(OLD)->>'kind') IS DISTINCT FROM (to_jsonb(NEW)->>'kind')) THEN
  RAISE EXCEPTION 'Master codes are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS location_code_immutable ON locations;
CREATE TRIGGER location_code_immutable BEFORE UPDATE OF code ON locations
  FOR EACH ROW EXECUTE FUNCTION preserve_master_code();

-- 2. Location tree guard: main's version. It walks up from the NEW parent
--    (the feature version walked the row's current parent, so moving a node
--    under its own descendant was not caught), checks children when a level
--    changes, and fills level/name for older flat writers.
CREATE OR REPLACE FUNCTION locations_tree_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE own int; outer_order int; cursor_id uuid; depth int := 0;
BEGIN
  IF NEW.level IS NULL THEN
    NEW.level := CASE
      WHEN nullif(btrim(NEW.room),'') IS NOT NULL THEN 'UNIT'
      WHEN nullif(btrim(NEW.floor),'') IS NOT NULL THEN 'FLOOR'
      WHEN nullif(btrim(NEW.building),'') IS NOT NULL THEN 'BUILDING'
      ELSE 'SITE' END;
  END IF;
  IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN
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

DROP TRIGGER IF EXISTS locations_tree_guard ON locations;
CREATE TRIGGER locations_tree_guard BEFORE INSERT OR UPDATE OF parent_id, level, name ON locations
  FOR EACH ROW EXECUTE FUNCTION locations_tree_guard();

-- 3. Location columns: one definition whichever 028 ran.
--    Blank names are filled by the guard above, so names are never empty.
ALTER TABLE locations ALTER COLUMN level SET DEFAULT 'UNIT';
ALTER TABLE locations ALTER COLUMN name SET DEFAULT '';
UPDATE locations SET name = coalesce(nullif(btrim(room),''), nullif(btrim(floor),''),
                                     nullif(btrim(building),''), nullif(btrim(site),''), code)
 WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE locations ALTER COLUMN level SET NOT NULL;
ALTER TABLE locations ALTER COLUMN name SET NOT NULL;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_name_check;
ALTER TABLE locations ADD CONSTRAINT locations_name_check
  CHECK (length(btrim(name)) BETWEEN 1 AND 150);

-- 4. Statuses (main 029 also registered these reference values).
INSERT INTO reference_values(kind,code,label)
SELECT 'STATUS', code, code
FROM unnest(ARRAY['Ready to Assign','In Use','Scrapped','Broken']) AS status(code)
ON CONFLICT (kind,code) DO NOTHING;

-- 5. Identifiers: every asset gets its QR code and barcode as identifiers
--    (main 030 backfilled these; the feature 030 did not).
INSERT INTO asset_identifiers(asset_id,kind,value,created_by)
SELECT id,'QR',asset_code,created_by FROM assets
ON CONFLICT (kind,value) DO NOTHING;
INSERT INTO asset_identifiers(asset_id,kind,value,created_by)
SELECT id,'BARCODE',btrim(barcode),created_by FROM assets
WHERE barcode IS NOT NULL AND btrim(barcode)<>''
ON CONFLICT (kind,value) DO NOTHING;

-- 6. Roles: team levels are roles too (feature 031). ADMIN / IT_ADMIN are
--    removed only when nothing references them; otherwise they stay allowed.
DO $$
DECLARE c text; legacy boolean;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='roles'::regclass AND contype='c' LOOP
    EXECUTE format('ALTER TABLE roles DROP CONSTRAINT %I', c);
  END LOOP;
  DELETE FROM roles r WHERE r.code IN ('ADMIN','IT_ADMIN')
    AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_code = r.code)
    AND NOT EXISTS (SELECT 1 FROM role_field_permissions p WHERE p.role_code = r.code)
    AND NOT EXISTS (SELECT 1 FROM asset_change_requests q WHERE q.owner_role = r.code);
  INSERT INTO roles(code) VALUES
    ('TEAM_LEAD'),('TEAM_MEMBER'),('STORE'),('TECHNICIAN'),('AUDITOR'),('INSURER'),('PROCUREMENT')
  ON CONFLICT DO NOTHING;
  SELECT EXISTS (SELECT 1 FROM roles WHERE code IN ('ADMIN','IT_ADMIN')) INTO legacy;
  IF legacy THEN
    ALTER TABLE roles ADD CONSTRAINT roles_code_valid CHECK (code IN (
      'ADMIN','IT_ADMIN','EMPLOYEE','SUPER_ADMIN','FINANCE','EXECUTIVE','TEAM_LEAD','TEAM_MEMBER',
      'STORE','TECHNICIAN','AUDITOR','INSURER','PROCUREMENT'));
  ELSE
    ALTER TABLE roles ADD CONSTRAINT roles_code_valid CHECK (code IN (
      'EMPLOYEE','SUPER_ADMIN','FINANCE','EXECUTIVE','TEAM_LEAD','TEAM_MEMBER',
      'STORE','TECHNICIAN','AUDITOR','INSURER','PROCUREMENT'));
  END IF;
END $$;

-- 7. Change requests default (feature 033).
ALTER TABLE asset_change_requests ALTER COLUMN proposed_changes SET DEFAULT '{}';

-- 8. Asset type -> category. Main 034 added a nullable column; 035 (feature)
--    expects NOT NULL DEFAULT 'Other'. Make sure 'Other' exists first so a
--    foreign key from main's version is satisfied.
INSERT INTO category_policies(category_code, handling_team_id)
VALUES ('Other', '00000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;
ALTER TABLE asset_type_policies ADD COLUMN IF NOT EXISTS category_code text;
UPDATE asset_type_policies SET category_code = 'Other' WHERE category_code IS NULL;
ALTER TABLE asset_type_policies ALTER COLUMN category_code SET DEFAULT 'Other';
ALTER TABLE asset_type_policies ALTER COLUMN category_code SET NOT NULL;

COMMIT;
