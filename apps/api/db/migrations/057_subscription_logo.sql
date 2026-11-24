BEGIN;

-- Vendor logo for each subscription, fetched once by the server from the website's domain and
-- served from this site (the page's security policy allows only images from this site).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS logo bytea CHECK (logo IS NULL OR octet_length(logo) <= 200000),
  ADD COLUMN IF NOT EXISTS logo_mime text CHECK (logo_mime IS NULL OR logo_mime IN ('image/png','image/jpeg','image/x-icon','image/vnd.microsoft.icon','image/webp','image/gif')),
  ADD COLUMN IF NOT EXISTS logo_fetched_at timestamptz;

COMMIT;
