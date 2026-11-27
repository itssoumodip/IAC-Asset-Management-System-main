BEGIN;
-- More pictures of one asset (front, back, screen, serial label…) beside its main photo in
-- asset_photos. Same limits as the main photo: private, metadata-free JPEG up to 80 KiB.
CREATE TABLE asset_extra_photos(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 asset_id uuid NOT NULL REFERENCES assets(id),
 label text NOT NULL CHECK(label IN ('Front','Back','Left side','Right side','Top','Screen','Keyboard','Serial label','Ports','Damage','Accessories','Other')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 81920),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(substring(content FROM 1 FOR 3)=decode('ffd8ff','hex'))
);
CREATE INDEX asset_extra_photos_asset_idx ON asset_extra_photos(asset_id, created_at);
COMMIT;
