BEGIN;

-- Owner decision: the project / grant tagging feature is removed entirely.
-- Assets lose their project tag; projects and the per-team requirement disappear.

DROP INDEX IF EXISTS assets_project;
ALTER TABLE assets DROP COLUMN IF EXISTS project_id;
DROP TABLE IF EXISTS projects;
ALTER TABLE teams DROP COLUMN IF EXISTS requires_project;

COMMIT;
