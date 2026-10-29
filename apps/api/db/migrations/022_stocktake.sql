BEGIN;
CREATE TABLE stocktake_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name varchar(160) NOT NULL,scope jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,closed_by uuid REFERENCES users(id),version int NOT NULL DEFAULT 1,CHECK((closed_at IS NULL)=(closed_by IS NULL)));
CREATE TABLE stocktake_expected(run_id uuid NOT NULL REFERENCES stocktake_runs(id),asset_id uuid NOT NULL REFERENCES assets(id),asset_code text NOT NULL,asset_version int NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(run_id,asset_id));
CREATE INDEX stocktake_expected_page ON stocktake_expected(run_id,asset_code,asset_id);
CREATE TABLE stocktake_observations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES stocktake_runs(id),asset_id uuid NOT NULL REFERENCES assets(id),outcome text NOT NULL CHECK(outcome IN ('SEEN','NOT_FOUND','MISMATCH')),note varchar(2000) NOT NULL,observed_by uuid NOT NULL REFERENCES users(id),observed_at timestamptz NOT NULL DEFAULT now(),asset_version int NOT NULL,request_key uuid NOT NULL,UNIQUE(run_id,request_key));
CREATE INDEX stocktake_observations_latest ON stocktake_observations(run_id,asset_id,observed_at DESC,id DESC);
CREATE TRIGGER immutable_stocktake_expected BEFORE UPDATE OR DELETE ON stocktake_expected FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_stocktake_observations BEFORE UPDATE OR DELETE ON stocktake_observations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
