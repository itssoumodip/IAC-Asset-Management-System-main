-- Link fixes found by link-check.sql on the production copy (27 Nov 2026). Only clear-cut ones:
--   1. IAC-IT-000209 is held by someone but its status says "Active"  -> In Use.
--   2. IAC-IT-000227 is In Store but still names a department         -> no department.
--   3. IAC-IT-000061 is a second record of IAC-IT-000044 (same laptop: serial 5CD3341GHJ, model,
--      price and holder; only the year was mistyped; the register's row 418 is that laptop and
--      Neeraj Lohan's 5CD333FFR9, which is IAC-IT-000045). It is taken off the register the same
--      way the app's "Remove from register" does: holder's record closed, history kept, restorable.
-- Each step checks the asset is still in the state found; otherwise the whole file stops.
-- No emails or notifications. Refuses to run twice.
\set ON_ERROR_STOP on
BEGIN;
-- The database checks every value this file sets (migration 065).
SET LOCAL iac.strict_links = 'on';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_events WHERE action = 'LINK_FIX_APPLIED' AND changes->>'tag' = 'link-fix-2026-11-27') THEN
    RAISE EXCEPTION 'These link fixes were already applied.';
  END IF;
END $$;
CREATE TEMP TABLE importer ON COMMIT DROP AS
  SELECT ur.user_id AS id FROM user_roles ur WHERE ur.role_code = 'SUPER_ADMIN' ORDER BY ur.granted_at LIMIT 1;

-- 1. Status follows custody.
DO $$ DECLARE n int; BEGIN
  UPDATE assets a SET status = 'In Use', version = version + 1, updated_at = now()
   WHERE a.asset_code = 'IAC-IT-000209' AND a.status = 'Active' AND a.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM assignments g WHERE g.asset_id = a.id AND g.ended_at IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'IAC-IT-000209 is no longer Active and held; nothing changed.'; END IF;
END $$;

-- 2. Stock in the store belongs to no department.
DO $$ DECLARE n int; BEGIN
  UPDATE assets SET department_id = NULL, version = version + 1, updated_at = now()
   WHERE asset_code = 'IAC-IT-000227' AND status = 'In Store' AND department_id IS NOT NULL AND removed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'IAC-IT-000227 is no longer In Store with a department; nothing changed.'; END IF;
END $$;

-- 3. Duplicate record off the register (the real laptop, IAC-IT-000044, is untouched).
DO $$ DECLARE dup uuid; keep uuid; BEGIN
  SELECT id INTO dup FROM assets WHERE asset_code = 'IAC-IT-000061' AND removed_at IS NULL AND serial_number = '5CD3341GHJ';
  SELECT id INTO keep FROM assets WHERE asset_code = 'IAC-IT-000044' AND removed_at IS NULL AND serial_number = '5CD3341GHJ';
  IF dup IS NULL OR keep IS NULL THEN RAISE EXCEPTION 'IAC-IT-000061 / 000044 are not as found; nothing changed.'; END IF;
  UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer),
         handover_note = coalesce(handover_note || ' ', '') || 'Closed: duplicate record of IAC-IT-000044.', version = version + 1
   WHERE asset_id = dup AND ended_at IS NULL;
  UPDATE assets SET removed_at = now(), removed_by = (SELECT id FROM importer),
         removed_reason = 'Duplicate record of IAC-IT-000044 (same serial 5CD3341GHJ, model, price and holder).',
         version = version + 1, updated_at = now()
   WHERE id = dup;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (dup, 'STATUS_CHANGE', 'Removed from the register: duplicate record of IAC-IT-000044', (SELECT id FROM importer));
  INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)
  VALUES ((SELECT id FROM importer), 'USER', 'asset', dup, 'ASSET_REMOVED',
          jsonb_build_object('reason', 'Duplicate record of IAC-IT-000044', 'assetCode', 'IAC-IT-000061'), gen_random_uuid());
END $$;

INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)
SELECT (SELECT id FROM importer), 'USER', 'asset', a.id, 'ASSET_UPDATED',
       jsonb_build_object('source', 'Link check fixes', 'assetCode', a.asset_code), gen_random_uuid()
  FROM assets a WHERE a.asset_code IN ('IAC-IT-000209', 'IAC-IT-000227');
INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)
VALUES ((SELECT id FROM importer), 'USER', 'import', NULL, 'LINK_FIX_APPLIED',
        jsonb_build_object('tag', 'link-fix-2026-11-27', 'assets', ARRAY['IAC-IT-000209', 'IAC-IT-000227', 'IAC-IT-000061']), gen_random_uuid());
DO $$ BEGIN RAISE NOTICE 'Fixed: 000209 status, 000227 department, 000061 duplicate removed.'; END $$;
COMMIT;
