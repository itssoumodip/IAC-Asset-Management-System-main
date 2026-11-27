BEGIN;
-- The database checks an asset's links the same way the app does (validateAsset), so data loaded
-- with SQL (imports, fixes) cannot point at a switched-off or missing value either:
--   category, subcategory, ownership, condition, risk, status, depreciation method, disposal method,
--   comment type and data wipe must be active list values; location and department must be active;
--   and a subcategory must belong to the asset's category.
-- Like the app, a value is checked only when it is set or changed, so existing assets that still
-- carry a since-retired value keep working until someone changes that field.
--
-- It is switched on per transaction by data scripts (imports, fixes) with
--   SET LOCAL iac.strict_links = 'on';
-- The app itself does these checks in validateAsset and deliberately tolerates some legacy data
-- (e.g. a historical subcategory/category mismatch stays editable), so app writes are not blocked.
CREATE OR REPLACE FUNCTION assets_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pair text[];
  new_value text;
  old_value text;
  expected_category text;
BEGIN
  IF coalesce(current_setting('iac.strict_links', true), '') <> 'on' THEN
    RETURN NEW;
  END IF;
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['category', 'CATEGORY'], ['asset_type', 'ASSET_TYPE'], ['ownership_type', 'OWNERSHIP'],
    ['condition', 'CONDITION'], ['risk_level', 'RISK'], ['status', 'STATUS'],
    ['depreciation_method', 'DEPRECIATION_METHOD'], ['disposal_method', 'DISPOSAL_METHOD'],
    ['comment_type', 'COMMENT_TYPE'], ['data_wipe_required', 'DATA_WIPE']
  ] LOOP
    new_value := to_jsonb(NEW) ->> pair[1];
    old_value := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> pair[1] END;
    IF new_value IS NOT NULL AND new_value IS DISTINCT FROM old_value
       AND NOT EXISTS (SELECT 1 FROM reference_values r WHERE r.kind = pair[2] AND r.code = new_value AND r.active) THEN
      RAISE EXCEPTION 'Asset %: % "%" is not an active value', NEW.asset_code, replace(pair[1], '_', ' '), new_value
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF NEW.location_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.location_id IS DISTINCT FROM OLD.location_id)
     AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = NEW.location_id AND l.active) THEN
    RAISE EXCEPTION 'Asset %: the location is switched off', NEW.asset_code USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.department_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id)
     AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.active) THEN
    RAISE EXCEPTION 'Asset %: the department is switched off', NEW.asset_code USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.category IS DISTINCT FROM OLD.category OR NEW.asset_type IS DISTINCT FROM OLD.asset_type THEN
    SELECT p.category_code INTO expected_category FROM asset_type_policies p WHERE p.asset_type_code = NEW.asset_type;
    IF expected_category IS NOT NULL AND expected_category <> NEW.category THEN
      RAISE EXCEPTION 'Asset %: subcategory "%" belongs to "%", not "%"', NEW.asset_code, NEW.asset_type, expected_category, NEW.category
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assets_reference_guard_trg
  BEFORE INSERT OR UPDATE OF category, asset_type, ownership_type, condition, risk_level, status, depreciation_method,
    disposal_method, comment_type, data_wipe_required, location_id, department_id
  ON assets FOR EACH ROW EXECUTE FUNCTION assets_reference_guard();
COMMIT;
