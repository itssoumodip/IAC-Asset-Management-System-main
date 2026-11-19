BEGIN;

INSERT INTO reference_values(kind, code, label)
VALUES
  ('DEPRECIATION_METHOD', 'SLM', 'Straight Line'),
  ('DEPRECIATION_METHOD', 'WDV', 'Written Down Value')
ON CONFLICT (kind, code) DO UPDATE
SET label = EXCLUDED.label, active = true, updated_at = now();

COMMIT;
