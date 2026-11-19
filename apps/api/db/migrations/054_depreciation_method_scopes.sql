BEGIN;

ALTER TABLE depreciation_method_rules
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category_code text;

CREATE INDEX IF NOT EXISTS depreciation_method_scope
  ON depreciation_method_rules(team_id, category_code);

INSERT INTO reference_values(kind, code, label, active)
VALUES ('DEPRECIATION_METHOD', 'SLM', 'Straight Line (SLM)', true),
       ('DEPRECIATION_METHOD', 'WDV', 'Written Down Value (WDV)', true)
ON CONFLICT (kind, code) DO UPDATE SET label=EXCLUDED.label, active=true, updated_at=now();

UPDATE assets
SET depreciation_method=CASE
  WHEN lower(btrim(depreciation_method)) IN ('straight line', 'straight line (slm)') THEN 'SLM'
  WHEN lower(btrim(depreciation_method)) IN ('written down value', 'written down value (wdv)') THEN 'WDV'
  ELSE depreciation_method
END
WHERE lower(btrim(depreciation_method)) IN
  ('straight line', 'straight line (slm)', 'written down value', 'written down value (wdv)');

DELETE FROM depreciation_method_rules
WHERE method_code IN (
  SELECT code FROM reference_values
  WHERE kind='DEPRECIATION_METHOD' AND lower(btrim(code)) IN
    ('straight line', 'straight line (slm)', 'written down value', 'written down value (wdv)')
    AND code NOT IN ('SLM', 'WDV')
);

DELETE FROM reference_values
WHERE kind='DEPRECIATION_METHOD'
  AND lower(btrim(code)) IN
    ('straight line', 'straight line (slm)', 'written down value', 'written down value (wdv)')
  AND code NOT IN ('SLM', 'WDV');

COMMIT;
