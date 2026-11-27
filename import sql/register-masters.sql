-- Master data the register imports need. Run FIRST, before register-desktops-import.sql,
-- register-televisions-import.sql and register-it-import.sql. Safe to run twice (adds only what is
-- missing). No emails or notifications.
--   0. The ASMC location exists and is switched on (the eye-tracker computer is kept there).
--   1. Subcategories: IT Accessory (IT Hardware) and Studio Equipment (Audio Visual), room/kit items
--      that need no named holder, owned and handled by IT.
--   2. Buildings at the project site, inside Sirakol (the project site, as corrected in the app):
--      Site Office, Security Block & Guard House, Canteen & Store.
--   3. The three site TVs imported earlier with "Project Site" move to their Sirakol building, as
--      the site desktops were moved in the app.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL iac.strict_links = 'on';

INSERT INTO locations(code, name, level, site) VALUES ('ASMC', 'ASMC', 'SITE', 'ASMC')
ON CONFLICT (code) DO UPDATE SET active = true, version = locations.version + 1, updated_at = now()
  WHERE NOT locations.active;

INSERT INTO reference_values(kind, code, label) VALUES
  ('ASSET_TYPE', 'IT Accessory', 'IT Accessory'),
  ('ASSET_TYPE', 'Studio Equipment', 'Studio Equipment')
ON CONFLICT (kind, code) DO NOTHING;
INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code, owning_team_id, handling_team_id)
SELECT v.code, false, v.category, t.id, t.id
  FROM (VALUES ('IT Accessory', 'IT Hardware'), ('Studio Equipment', 'Audio Visual')) AS v(code, category)
  CROSS JOIN teams t WHERE t.code = 'IT'
ON CONFLICT (asset_type_code) DO NOTHING;

INSERT INTO locations(code, name, level, parent_id, site, building)
SELECT v.code, v.name, 'BUILDING', p.id, 'Sirakol', v.name
  FROM (VALUES ('IAC-SITE-SIRAKOL-OFFICE', 'Site Office'),
               ('IAC-SITE-SIRAKOL-SB', 'Security Block & Guard House'),
               ('IAC-SITE-SIRAKOL-CANTEEN', 'Canteen & Store')) AS v(code, name)
  JOIN locations p ON p.code = 'IAC-SITE-SIRAKOL'
ON CONFLICT (code) DO NOTHING;

-- Site TVs from register-televisions-import.sql: Project Site -> their building at Sirakol.
UPDATE assets a SET location_id = l.id, version = a.version + 1, updated_at = now()
  FROM (VALUES ('84', 'IAC-SITE-SIRAKOL'), ('92', 'IAC-SITE-SIRAKOL-SB'), ('118', 'IAC-SITE-SIRAKOL-OFFICE')) AS v(row, code)
  JOIN locations l ON l.code = v.code
 WHERE a.legacy_metadata->'financeRegister'->>'row' = v.row AND a.asset_type = 'Television' AND a.removed_at IS NULL
   AND a.location_id = (SELECT id FROM locations WHERE code = 'IAC-SITE');

DO $$ BEGIN
  RAISE NOTICE 'Subcategories: %, Sirakol buildings: %',
    (SELECT count(*) FROM asset_type_policies WHERE asset_type_code IN ('IT Accessory', 'Studio Equipment')),
    (SELECT count(*) FROM locations WHERE code LIKE 'IAC-SITE-SIRAKOL-%');
END $$;
COMMIT;
