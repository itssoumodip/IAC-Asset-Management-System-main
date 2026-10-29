BEGIN;
ALTER TABLE stocktake_observations ADD COLUMN sequence_no bigserial NOT NULL;
CREATE INDEX stocktake_observations_sequence ON stocktake_observations(run_id,asset_id,sequence_no DESC);
COMMIT;
