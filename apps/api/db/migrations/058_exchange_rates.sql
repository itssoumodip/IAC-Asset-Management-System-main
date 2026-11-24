BEGIN;

-- Latest rupee value of one unit of each foreign currency, refreshed by the server from a public
-- rates service. Kept here so totals still convert (with the last known rate) if it is down.
CREATE TABLE IF NOT EXISTS exchange_rates (
  currency char(3) PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$'),
  inr_per_unit numeric(18,6) NOT NULL CHECK (inr_per_unit > 0),
  rate_date timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL
);

COMMIT;
