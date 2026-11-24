BEGIN;

-- Vendors: the companies the organisation buys from or works with. Assets and subscriptions are
-- linked by name (an asset's supplier or a subscription's vendor matching the vendor's name), so
-- existing records connect without being changed.

CREATE SEQUENCE IF NOT EXISTS vendor_number_seq;

CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_code text NOT NULL UNIQUE DEFAULT ('VEN-' || lpad(nextval('vendor_number_seq')::text, 4, '0')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  services text CHECK (services IS NULL OR length(services) <= 500),
  contact_person text CHECK (contact_person IS NULL OR length(contact_person) <= 200),
  phone text CHECK (phone IS NULL OR length(phone) <= 100),
  email text CHECK (email IS NULL OR length(email) <= 500),
  address text CHECK (address IS NULL OR length(address) <= 1000),
  website text CHECK (website IS NULL OR length(website) <= 500),
  gstin text CHECK (gstin IS NULL OR length(gstin) <= 20),
  -- Our own rating of the vendor, 0 to 10.
  score numeric(3,1) CHECK (score IS NULL OR (score >= 0 AND score <= 10)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  notes text CHECK (notes IS NULL OR length(notes) <= 5000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
-- One vendor per name, ignoring case and surrounding spaces (that is how assets link to it).
CREATE UNIQUE INDEX IF NOT EXISTS vendors_name_key ON vendors (lower(btrim(name)));
-- Lets the asset link by supplier name use an index.
CREATE INDEX IF NOT EXISTS assets_supplier_name ON assets (lower(btrim(supplier))) WHERE supplier IS NOT NULL;

-- Our staff who deal with the vendor (the sheet's "Reference person"; can be more than one).
CREATE TABLE IF NOT EXISTS vendor_reference_people (
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (vendor_id, user_id)
);

COMMIT;
