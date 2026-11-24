BEGIN;

-- Vendor names match ignoring case, spaces and punctuation, so an asset whose supplier is written
-- "Comp-Tech Sales & Services" or "Comp Tech Sales and Services" links to the vendor
-- "Comp - Tech Sales & Services". "&" and "and" count as the same.
CREATE OR REPLACE FUNCTION vendor_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT nullif(regexp_replace(regexp_replace(lower(coalesce(value, '')), '\mand\M', '&', 'g'), '[^a-z0-9&]+', '', 'g'), '') $$;

DROP INDEX IF EXISTS vendors_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS vendors_name_key ON vendors (vendor_key(name));
DROP INDEX IF EXISTS assets_supplier_name;
CREATE INDEX IF NOT EXISTS assets_supplier_key ON assets (vendor_key(supplier)) WHERE supplier IS NOT NULL;

COMMIT;
