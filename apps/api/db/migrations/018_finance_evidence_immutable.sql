BEGIN;
CREATE TRIGGER immutable_finance_events BEFORE UPDATE OR DELETE ON asset_finance_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
