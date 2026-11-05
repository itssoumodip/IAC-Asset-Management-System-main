BEGIN;

-- Depreciation schedules (P22): track capitalisation date and per-asset depreciation values.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS capitalisation_date date;

CREATE TABLE depreciation_schedules(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  financial_year_start int NOT NULL,
  method text NOT NULL CHECK(method IN ('SLM','WDV')),
  rate numeric(5,2) NOT NULL,
  purchase_cost numeric(14,2) NOT NULL,
  opening_value numeric(14,2) NOT NULL,
  depreciation_charge numeric(14,2) NOT NULL,
  closing_value numeric(14,2) NOT NULL,
  accumulated_depreciation numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, financial_year_start)
);

CREATE INDEX depreciation_schedules_asset ON depreciation_schedules(asset_id);
CREATE INDEX depreciation_schedules_fy ON depreciation_schedules(financial_year_start);

COMMIT;
