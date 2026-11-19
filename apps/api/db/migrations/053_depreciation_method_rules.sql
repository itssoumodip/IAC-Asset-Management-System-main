BEGIN;

CREATE TABLE depreciation_method_rules (
  method_code text PRIMARY KEY,
  calculation_type text NOT NULL CHECK (calculation_type IN ('SLM', 'WDV')),
  rate_percent numeric(5,2) CHECK (rate_percent IS NULL OR (rate_percent > 0 AND rate_percent <= 100)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO reference_values(kind, code, label, active)
VALUES ('DEPRECIATION_METHOD', 'SLM', 'Straight Line (SLM)', true),
       ('DEPRECIATION_METHOD', 'WDV', 'Written Down Value (WDV)', true)
ON CONFLICT (kind, code) DO UPDATE SET label=EXCLUDED.label, active=true, updated_at=now();

INSERT INTO depreciation_method_rules(method_code, calculation_type, rate_percent)
VALUES ('SLM', 'SLM', NULL), ('WDV', 'WDV', 15)
ON CONFLICT (method_code) DO UPDATE
SET calculation_type=EXCLUDED.calculation_type,
    rate_percent=EXCLUDED.rate_percent,
    updated_at=now();

-- Preserve legacy per-asset method names as selectable WDV methods.
INSERT INTO reference_values(kind, code, label, active)
SELECT DISTINCT 'DEPRECIATION_METHOD', a.depreciation_method, a.depreciation_method, true
FROM assets a
WHERE a.depreciation_method IS NOT NULL
  AND btrim(a.depreciation_method) <> ''
ON CONFLICT (kind, code) DO NOTHING;

INSERT INTO depreciation_method_rules(method_code, calculation_type, rate_percent)
SELECT DISTINCT a.depreciation_method, 'WDV', 15
FROM assets a
WHERE a.depreciation_method IS NOT NULL
  AND btrim(a.depreciation_method) <> ''
  AND a.depreciation_method NOT IN ('SLM', 'WDV')
ON CONFLICT (method_code) DO NOTHING;

COMMIT;
