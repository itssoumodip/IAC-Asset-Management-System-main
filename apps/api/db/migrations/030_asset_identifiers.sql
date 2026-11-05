BEGIN;

-- Asset identifiers: QR, BARCODE, NFC, RFID tags linked to assets
CREATE TABLE asset_identifiers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL CHECK(kind = ANY (ARRAY['QR','BARCODE','NFC','RFID'])),
  value text NOT NULL CHECK(length(btrim(value)) >= 1 AND length(btrim(value)) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)
);

CREATE UNIQUE INDEX asset_identifiers_kind_value_key ON asset_identifiers(kind, value);
CREATE INDEX asset_identifiers_asset ON asset_identifiers(asset_id);

COMMIT;
