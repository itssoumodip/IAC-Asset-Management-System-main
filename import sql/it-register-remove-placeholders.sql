-- Remove the 77 empty placeholder rows of the IT register from the register.
-- IAC-IT-000086..000095 and IAC-IT-000107..000173 have no description, brand, model, serial,
-- cost or holder. They are hidden from lists, dashboards, counts, exports and scans; their
-- record and history stay, and each can be restored from its asset page.
-- Safety: an asset that has since gained real details or a holder is skipped.
-- Needs migration 051_asset_removal (deployed with the app). Sends no notifications.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assets' AND column_name='removed_at') THEN
    RAISE EXCEPTION 'Deploy the latest app first (migration 051_asset_removal adds removed_at).';
  END IF;
END $$;

CREATE TEMP TABLE importer ON COMMIT DROP AS
  SELECT ur.user_id AS id FROM user_roles ur WHERE ur.role_code='SUPER_ADMIN' ORDER BY ur.granted_at LIMIT 1;

CREATE TEMP TABLE targets ON COMMIT DROP AS
SELECT a.id, a.asset_code FROM assets a
WHERE (a.asset_code ~ '^IAC-IT-0000(8[6-9]|9[0-5])$' OR a.asset_code BETWEEN 'IAC-IT-000107' AND 'IAC-IT-000173')
  AND a.removed_at IS NULL
  AND nullif(btrim(coalesce(a.serial_number,'')),'') IS NULL
  AND nullif(btrim(coalesce(a.manufacturer,'')),'') IS NULL
  AND nullif(btrim(coalesce(a.model,'')),'') IS NULL
  AND a.purchase_cost IS NULL
  AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.ended_at IS NULL);

UPDATE assets a SET removed_at = now(), removed_by = (SELECT id FROM importer),
  removed_reason = 'Empty placeholder row in the IT asset register', version = a.version + 1, updated_at = now()
FROM targets t WHERE a.id = t.id;

INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
SELECT id, 'STATUS_CHANGE', 'Removed from the register: Empty placeholder row in the IT asset register', (SELECT id FROM importer)
FROM targets;

INSERT INTO audit_events(actor_kind, request_id, actor_id, entity_type, entity_id, action, changes)
SELECT 'USER', gen_random_uuid(), (SELECT id FROM importer), 'asset', NULL, 'ASSETS_REMOVED_BULK',
  jsonb_build_object('count', (SELECT count(*) FROM targets),
                     'codes', (SELECT jsonb_agg(asset_code ORDER BY asset_code) FROM targets),
                     'reason', 'Empty placeholder rows in the IT asset register');

SELECT 'removed now' AS item, count(*)::text AS n FROM targets
UNION ALL SELECT 'still on the register (IT)', count(*)::text FROM assets WHERE asset_code LIKE 'IAC-IT-%' AND removed_at IS NULL;
COMMIT;
