BEGIN;

-- "No depreciation" methods for assets that keep their value in the books: land, stamp duty on
-- land, live stock, and intangibles the accounts do not write down. The run skips them.
ALTER TABLE depreciation_method_rules DROP CONSTRAINT depreciation_method_rules_calculation_type_check;
ALTER TABLE depreciation_method_rules ADD CONSTRAINT depreciation_method_rules_calculation_type_check
  CHECK (calculation_type IN ('SLM', 'WDV', 'NONE'));

INSERT INTO reference_values(kind, code, label)
VALUES ('DEPRECIATION_METHOD', 'NO_DEPRECIATION', 'No depreciation (land and similar)')
ON CONFLICT (kind, code) DO NOTHING;
INSERT INTO depreciation_method_rules(method_code, calculation_type, rate_percent)
VALUES ('NO_DEPRECIATION', 'NONE', NULL)
ON CONFLICT (method_code) DO NOTHING;

COMMIT;
