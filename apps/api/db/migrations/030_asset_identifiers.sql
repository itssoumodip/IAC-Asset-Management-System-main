BEGIN;

CREATE TABLE asset_identifiers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL CHECK(kind IN ('QR','BARCODE','NFC','RFID')),
  value text NOT NULL CHECK(length(btrim(value)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE(kind,value)
);
CREATE INDEX asset_identifiers_asset ON asset_identifiers(asset_id);

INSERT INTO asset_identifiers(asset_id,kind,value,created_by)
SELECT id,'QR',asset_code,created_by FROM assets
ON CONFLICT (kind,value) DO NOTHING;
INSERT INTO asset_identifiers(asset_id,kind,value,created_by)
SELECT id,'BARCODE',barcode,created_by FROM assets
WHERE barcode IS NOT NULL AND btrim(barcode)<>''
ON CONFLICT (kind,value) DO NOTHING;

COMMIT;
