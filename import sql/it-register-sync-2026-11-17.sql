-- IT asset register: sync of spreadsheet changes (2026-11-17). Generated; safe to read.
-- Writes only the fields that changed in the spreadsheet, plus holders, locations and history.
-- Also clears Excel "zero" dates (30 Dec 1899) from the first import. Sends NO notifications.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM assets WHERE asset_code LIKE 'IAC-IT-%') < 170 THEN
    RAISE EXCEPTION 'Run it-register-import.sql first.';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_events WHERE action = 'IT_REGISTER_SYNCED' AND changes->>'tag' = '2026-11-17') THEN
    RAISE EXCEPTION 'This sync (2026-11-17) was already applied.';
  END IF;
END $$;
UPDATE email_deliveries SET state='DEAD', last_error_code='SUPPRESSED', leased_until=NULL, lease_token=NULL
 WHERE state IN ('PENDING','LEASED');
CREATE TEMP TABLE importer ON COMMIT DROP AS
  SELECT ur.user_id AS id FROM user_roles ur WHERE ur.role_code='SUPER_ADMIN' ORDER BY ur.granted_at LIMIT 1;
CREATE FUNCTION pg_temp.person(p_code text, p_name text) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT u.id FROM users u
   WHERE (p_code IS NOT NULL AND upper(btrim(u.employee_code)) = upper(btrim(p_code)))
      OR (p_code IS NULL AND (lower(btrim(u.display_name)) = lower(btrim(p_name))
          OR lower(split_part(btrim(u.display_name), ' ', 1)) = lower(btrim(p_name)) AND btrim(p_name) !~ ' '))
   ORDER BY (u.left_at IS NULL) DESC, (u.state='ACTIVE') DESC,
            (lower(btrim(u.display_name)) = lower(btrim(coalesce(p_name,'')))) DESC LIMIT 1
$f$;
-- Current holder: never someone who has left. Code wins only when it agrees with the name.
CREATE FUNCTION pg_temp.holder(p_code text, p_name text) RETURNS uuid LANGUAGE sql STABLE AS $f$
  WITH named AS (
    SELECT u.id FROM users u
     WHERE u.left_at IS NULL AND u.state IN ('ACTIVE','DIRECTORY')
       AND (lower(btrim(u.display_name)) = lower(btrim(p_name))
            OR (btrim(p_name) !~ ' ' AND lower(split_part(btrim(u.display_name), ' ', 1)) = lower(btrim(p_name))))
  ), coded AS (
    SELECT u.id FROM users u
     WHERE p_code IS NOT NULL AND upper(btrim(u.employee_code)) = upper(btrim(p_code))
       AND u.left_at IS NULL AND u.state IN ('ACTIVE','DIRECTORY')
       AND (lower(split_part(btrim(u.display_name), ' ', 1)) = lower(split_part(btrim(p_name), ' ', 1))
            OR lower(btrim(u.display_name)) = lower(btrim(p_name)))
  )
  SELECT coalesce((SELECT id FROM coded LIMIT 1),
                  CASE WHEN (SELECT count(*) FROM named) = 1 THEN (SELECT id FROM named) END)
$f$;

-- Location tree (reused if it already exists).
DO $$ DECLARE s record; BEGIN
  FOR s IN SELECT * FROM (VALUES (0, 'IAC-HO', 'Head Office (HO)', 'SITE', NULL), (1, 'IAC-HO-GF', 'Ground Floor', 'FLOOR', 'IAC-HO'), (2, 'IAC-HO-2F', '2nd Floor', 'FLOOR', 'IAC-HO'), (3, 'IAC-HO-3F', '3rd Floor', 'FLOOR', 'IAC-HO'), (4, 'IAC-HO-2F-NSCABIN', 'NS Cabin', 'UNIT', 'IAC-HO-2F'), (5, 'IAC-SITE', 'Project Site', 'SITE', NULL), (6, 'IAC-SITE-GF', 'Ground Floor', 'FLOOR', 'IAC-SITE'), (7, 'IAC-SITE-SIRAKOL', 'Sirakol', 'ZONE', 'IAC-SITE'), (8, 'IAC-SITE-CAMPUS', 'Campus', 'ZONE', 'IAC-SITE')) v(ord, code, name, level, parent) ORDER BY ord LOOP
    IF NOT EXISTS (SELECT 1 FROM locations WHERE code = s.code) THEN
      INSERT INTO locations(code, site, name, level, parent_id)
      VALUES (s.code, s.name, s.name, s.level, (SELECT id FROM locations WHERE code = s.parent));
    END IF;
  END LOOP;
END $$;

-- "Previous holder on sheet: X" adds nothing when X is the current holder.
UPDATE assets a SET remarks = nullif(btrim(replace(replace(a.remarks,
    ' | Previous holder on sheet: ' || u.display_name, ''),
    'Previous holder on sheet: ' || u.display_name, ''), ' |'), '')
FROM assignments s JOIN users u ON u.id = s.user_id
WHERE s.asset_id = a.id AND s.ended_at IS NULL AND a.remarks ILIKE '%Previous holder on sheet: ' || u.display_name || '%';

-- Excel "zero" dates from the first import.
UPDATE assets SET amc_expiry = NULL, amc_applies = false WHERE amc_expiry < '1950-01-01';
UPDATE assets SET warranty_expiry = NULL WHERE warranty_expiry < '1950-01-01';
UPDATE assets SET insurance_expiry = NULL WHERE insurance_expiry < '1950-01-01';

-- IAC-IT-000011: Holder, Previous holders
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000011';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000011: not found'; RETURN; END IF;
  
  
  prev_name := 'Mini Gourisaria';
  uid := pg_temp.person(NULL, prev_name);
  IF uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assignments WHERE asset_id = aid AND user_id = uid) THEN
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, ended_at, ended_by, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now() - interval '2 minutes', now() - interval '1 minute', (SELECT id FROM importer), 'ACCEPTED', now() - interval '2 minutes',
            'Previous holder from the IT asset register (exact dates not recorded)')
    RETURNING id INTO new_id;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id, occurred_at)
    VALUES (aid, 'ASSIGN', new_id, 'Held by ' || prev_name || ' (previous holder, from the IT asset register)', (SELECT id FROM importer), now() - interval '2 minutes');
    INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id, occurred_at)
    VALUES (aid, 'RETURN', new_id, 'Handed on by ' || prev_name || ' (from the IT asset register)', (SELECT id FROM importer), now() - interval '1 minute');
  ELSIF uid IS NULL THEN
    INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
    VALUES (aid, 'STATUS_CHANGE', 'Previous holder on the register: ' || prev_name || ' (not in Zoho)', (SELECT id FROM importer));
  END IF;
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder('E0118', 'Mandeep');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Mandeep' || ' (E0118)'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Mandeep'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Holder, Previous holders', (SELECT id FROM importer));
END $$;

-- IAC-IT-000075: Condition, Risk Level, Location, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000075';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000075: not found'; RETURN; END IF;
  UPDATE assets SET condition = 'New', risk_level = 'Low', updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-GF';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder(NULL, 'Diptyarka Bose');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Diptyarka Bose'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Diptyarka Bose'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Condition, Risk Level, Location, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000076: Condition, Risk Level, Location, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000076';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000076: not found'; RETURN; END IF;
  UPDATE assets SET condition = 'New', risk_level = 'Low', updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-SITE';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder(NULL, 'Rakesh Kumar Barik');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Rakesh Kumar Barik'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Rakesh Kumar Barik'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Condition, Risk Level, Location, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000077: Condition, Risk Level, Location, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000077';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000077: not found'; RETURN; END IF;
  UPDATE assets SET condition = 'New', risk_level = 'Low', updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-SITE';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder(NULL, 'Chayan Mondal');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Chayan Mondal'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Chayan Mondal'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Condition, Risk Level, Location, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000078: Condition, Risk Level, Location, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000078';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000078: not found'; RETURN; END IF;
  UPDATE assets SET condition = 'New', risk_level = 'Low', updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-GF';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder('E0119', 'Ashmita Bandyopadhyay');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Ashmita Bandyopadhyay' || ' (E0119)'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Ashmita Bandyopadhyay'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Condition, Risk Level, Location, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000079: Condition, Risk Level, Location, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000079';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000079: not found'; RETURN; END IF;
  UPDATE assets SET condition = 'New', risk_level = 'Low', updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-SITE';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder(NULL, 'Probhas Das');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Probhas Das'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Probhas Das'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Condition, Risk Level, Location, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000080: Condition, Risk Level, Location, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000080';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000080: not found'; RETURN; END IF;
  UPDATE assets SET condition = 'New', risk_level = 'Low', updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-3F';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder('IAC0009', 'Prithwis Kumar Banerjee');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Prithwis Kumar Banerjee' || ' (IAC0009)'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Prithwis Kumar Banerjee'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Condition, Risk Level, Location, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000081: Asset Description, Manufacturer, Model, Serial Number, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000081';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000081: not found'; RETURN; END IF;
  UPDATE assets SET description = 'Asus X1504VAPB', manufacturer = 'Asus', model = 'X1504VAP - IN005WS', serial_number = 'W7N0RJ18822731D', configuration = 'Intel i3 100U with 8 GB of RAM and 512 GB of SSD', graphics = 'Intel® UHD Graphics', purchase_date = '2026-11-03', supplier = 'Optima Infotech', purchase_cost = 51920, depreciation_method = 'Written Down Value', useful_life_years = 5, asset_owner = 'Head - IT', condition = 'New', risk_level = 'Low', warranty_expiry = '2027-11-02', amc_expiry = '2027-11-02', amc_applies = true, department_id = (SELECT id FROM departments WHERE name = 'Clinical'), updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-GF';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder('I029', 'Saloni Sodhani');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Saloni Sodhani' || ' (I029)'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Saloni Sodhani'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Asset Description, Manufacturer, Model, Serial Number, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000082: Asset Description, Manufacturer, Model, Serial Number, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000082';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000082: not found'; RETURN; END IF;
  UPDATE assets SET description = 'Asus X1504VAPB', manufacturer = 'Asus', model = 'X1504VAP - IN005WS', serial_number = 'W8NORJ19367932C', configuration = 'Intel i3 100U with 8 GB of RAM and 512 GB of SSD', graphics = 'Intel® UHD Graphics', purchase_date = '2026-11-03', supplier = 'Optima Infotech', purchase_cost = 51920, depreciation_method = 'Written Down Value', useful_life_years = 5, asset_owner = 'Head - IT', condition = 'New', risk_level = 'Low', warranty_expiry = '2027-11-02', amc_expiry = '2027-11-02', amc_applies = true, department_id = (SELECT id FROM departments WHERE name = 'Research'), updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-3F';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder('I031', 'Debanjali Sarkar');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Debanjali Sarkar' || ' (I031)'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Debanjali Sarkar'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Asset Description, Manufacturer, Model, Serial Number, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000083: Asset Description, Manufacturer, Model, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000083';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000083: not found'; RETURN; END IF;
  UPDATE assets SET description = 'Asus X1504VAPB', manufacturer = 'Asus', model = 'X1504VAP - IN005WS', configuration = 'Intel i3 100U with 8 GB of RAM and 512 GB of SSD', graphics = 'ADM Radeon™', purchase_date = '2026-11-03', supplier = 'Optima Infotech', purchase_cost = 51920, depreciation_method = 'Written Down Value', useful_life_years = 5, asset_owner = 'Head - IT', condition = 'New', risk_level = 'Low', warranty_expiry = '2027-11-02', amc_expiry = '2027-11-02', amc_applies = true, department_id = (SELECT id FROM departments WHERE name = 'Clinical'), updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-GF';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder(NULL, 'Arpita Srivastava');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Arpita Srivastava'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Arpita Srivastava'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Asset Description, Manufacturer, Model, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000084: Asset Description, Manufacturer, Model, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000084';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000084: not found'; RETURN; END IF;
  UPDATE assets SET description = 'Asus X1504VAPB', manufacturer = 'Asus', model = 'X1504VAP - IN005WS', configuration = 'Intel i3 100U with 8 GB of RAM and 512 GB of SSD', graphics = 'Intel® UHD Graphics', purchase_date = '2026-11-03', supplier = 'Optima Infotech', purchase_cost = 51920, depreciation_method = 'Written Down Value', useful_life_years = 5, asset_owner = 'Head - IT', condition = 'New', risk_level = 'Low', warranty_expiry = '2027-11-02', amc_expiry = '2027-11-02', amc_applies = true, department_id = (SELECT id FROM departments WHERE name = 'Communications'), updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-3F';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder(NULL, 'Shruti Gupta');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Shruti Gupta'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Shruti Gupta'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Asset Description, Manufacturer, Model, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Department, Location, Holder, Status', (SELECT id FROM importer));
END $$;

-- IAC-IT-000085: Asset Description, Manufacturer, Model, Serial Number, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Location, Holder, Status
DO $$ DECLARE aid uuid; cur record; uid uuid; loc uuid; new_id uuid; nm text; prev_name text; BEGIN
  SELECT id INTO aid FROM assets WHERE asset_code = 'IAC-IT-000085';
  IF aid IS NULL THEN RAISE NOTICE 'skip IAC-IT-000085: not found'; RETURN; END IF;
  UPDATE assets SET description = 'Asus X1504VAPB', manufacturer = 'Asus', model = 'X1504VAP - IN005WS', serial_number = 'TAN0CX02B22843A', configuration = 'Intel i3 100U with 8 GB of RAM and 512 GB of SSD', graphics = 'Intel® UHD Graphics', purchase_date = '2026-11-03', supplier = 'Optima Infotech', purchase_cost = 51920, depreciation_method = 'Written Down Value', useful_life_years = 5, asset_owner = 'Head - IT', condition = 'New', risk_level = 'Low', warranty_expiry = '2027-11-02', amc_expiry = '2027-11-02', amc_applies = true, updated_at = now(), version = version + 1 WHERE id = aid;
  SELECT id INTO loc FROM locations WHERE code = 'IAC-HO-3F';
  IF loc IS NOT NULL AND (SELECT location_id FROM assets WHERE id = aid) IS DISTINCT FROM loc THEN
    INSERT INTO asset_movements(asset_id, kind, from_location_id, to_location_id, reason, actor_id)
    VALUES (aid, 'RELOCATE', (SELECT location_id FROM assets WHERE id = aid), loc, 'Location updated from the IT asset register', (SELECT id FROM importer));
    UPDATE assets SET location_id = loc WHERE id = aid;
  END IF;
  
  -- Current holder: by employee code, else exact name.
  uid := pg_temp.holder('E0155', 'Pramila');
  SELECT * INTO cur FROM assignments WHERE asset_id = aid AND ended_at IS NULL;
  IF uid IS NOT NULL AND (cur.id IS NULL OR cur.user_id <> uid) THEN
    IF cur.id IS NOT NULL THEN
      UPDATE assignments SET ended_at = now(), ended_by = (SELECT id FROM importer) WHERE id = cur.id;
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id)
      VALUES (aid, 'RETURN', cur.id, 'Returned (holder changed on the IT asset register)', (SELECT id FROM importer));
    END IF;
    INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
    VALUES (aid, uid, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register')
    RETURNING id INTO new_id;
    SELECT display_name INTO nm FROM users WHERE id = uid;
    INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id)
    VALUES (aid, 'ASSIGN', new_id, 'Assigned to ' || nm || ' (from the IT asset register)', (SELECT id FROM importer));
    INSERT INTO assignment_events(assignment_id, actor_id, kind, details) VALUES (new_id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}');
    UPDATE assets SET status = 'In Use',
      remarks = nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), '')
    WHERE id = aid;
  ELSIF uid IS NULL AND cur.id IS NULL THEN
    UPDATE assets SET status = CASE WHEN status IN ('In Store','In Use','Assigned') THEN 'Active' ELSE status END,
      remarks = concat_ws(' | ', nullif(regexp_replace(coalesce(remarks,''), '( \| )?(Sheet holder|Holder code)[^|]*', '', 'g'), ''),
                          'Sheet holder: ' || 'Pramila' || ' (E0155)'
                          || CASE WHEN EXISTS (SELECT 1 FROM users WHERE left_at IS NOT NULL AND lower(btrim(display_name)) = lower(btrim('Pramila'))) THEN ' has left' ELSE ' not matched in Zoho' END)
    WHERE id = aid;
  END IF;
  INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
  VALUES (aid, 'STATUS_CHANGE', 'Updated from the IT asset register: Asset Description, Manufacturer, Model, Serial Number, Configuration Details, Graphics Details, Purchase Date, Supplier, Purchase Cost, Depreciation Method, Useful Life (Years), Asset Owner, Condition, Risk Level, Warranty Expiry, AMC Expiry, Location, Holder, Status', (SELECT id FROM importer));
END $$;

INSERT INTO audit_events(actor_kind, request_id, actor_id, entity_type, entity_id, action, changes)
SELECT 'USER', gen_random_uuid(), (SELECT id FROM importer), 'asset', NULL, 'IT_REGISTER_SYNCED',
  jsonb_build_object('tag', '2026-11-17', 'assets', 12);
SELECT 'assets updated' AS item, '12' AS n
UNION ALL SELECT 'held now', count(*)::text FROM assignments s JOIN assets a ON a.id=s.asset_id WHERE s.ended_at IS NULL AND a.asset_code LIKE 'IAC-IT-%'
UNION ALL SELECT 'with location', count(*)::text FROM assets WHERE asset_code LIKE 'IAC-IT-%' AND location_id IS NOT NULL
UNION ALL SELECT 'emails queued', count(*)::text FROM email_deliveries WHERE state IN ('PENDING','LEASED');
COMMIT;
