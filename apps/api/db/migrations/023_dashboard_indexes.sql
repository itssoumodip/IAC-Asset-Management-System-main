-- Executive dashboard: indexes for the counters and trend queries that EXPLAIN showed as sequential scans.
CREATE INDEX assets_warranty_expiry ON assets(warranty_expiry) WHERE warranty_expiry IS NOT NULL;
CREATE INDEX assets_amc_expiry ON assets(amc_expiry) WHERE amc_applies AND amc_expiry IS NOT NULL;
CREATE INDEX assets_team_status_value ON assets(owning_team_id,status) INCLUDE (purchase_cost,currency);
CREATE INDEX tickets_completed_at ON tickets(completed_at) WHERE completed_at IS NOT NULL;
