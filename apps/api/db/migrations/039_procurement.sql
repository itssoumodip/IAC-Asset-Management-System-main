BEGIN;

-- P25 Procurement: approved requests to buy, out-of-stock products, basic purchase record.
CREATE TABLE purchases(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_code text NOT NULL UNIQUE CHECK (length(btrim(purchase_code)) BETWEEN 1 AND 40),
  supplier text NOT NULL CHECK (length(btrim(supplier)) BETWEEN 1 AND 200),
  purchase_date date NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);

CREATE INDEX purchases_date ON purchases(purchase_date);
CREATE INDEX purchases_supplier ON purchases(supplier);

COMMIT;
