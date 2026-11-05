BEGIN;

-- Asset types belong to a category so Categories & teams can group them.
-- The original migration only stored the type code, which left the categories
-- page querying a column that did not exist.
ALTER TABLE asset_type_policies
  ADD COLUMN IF NOT EXISTS category_code text NOT NULL DEFAULT 'Other';

UPDATE asset_type_policies SET category_code = CASE asset_type_code
  WHEN 'Laptop'     THEN 'IT Hardware'
  WHEN 'Desktop'    THEN 'IT Hardware'
  WHEN 'Monitor'    THEN 'IT Hardware'
  WHEN 'Printer'    THEN 'Office Equipment'
  WHEN 'Networking' THEN 'Security & ELV'
  WHEN 'Chair'      THEN 'Furniture'
  WHEN 'Table'      THEN 'Furniture'
  WHEN 'Kitchen'    THEN 'Kitchen Equipment'
  WHEN 'Light'      THEN 'Electrical Equipment'
  ELSE category_code
END;

CREATE INDEX IF NOT EXISTS asset_type_policies_category
  ON asset_type_policies(category_code);

COMMIT;
