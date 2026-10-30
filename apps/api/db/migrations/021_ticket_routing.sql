ALTER TABLE tickets ADD COLUMN team_id uuid REFERENCES teams(id);
UPDATE tickets SET team_id='00000000-0000-4000-8000-000000000001' WHERE team_id IS NULL;
ALTER TABLE tickets ALTER COLUMN team_id SET NOT NULL;
CREATE INDEX tickets_team_status_created ON tickets(team_id,status,created_at);

CREATE TABLE ticket_category_teams (
  category_code text PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES teams(id)
);

ALTER TABLE ticket_updates DROP CONSTRAINT ticket_updates_kind_check;
ALTER TABLE ticket_updates ADD CONSTRAINT ticket_updates_kind_check
  CHECK (kind IN ('CREATED','COMMENT','OWNER_CHANGED','STATUS_CHANGED','TEAM_CHANGED'));
