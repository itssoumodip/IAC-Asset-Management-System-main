BEGIN;
-- Tickets created without explicit routing (older scripts, direct SQL) land in the IT queue,
-- matching the service's fallback for unmapped categories.
ALTER TABLE tickets ALTER COLUMN team_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
COMMIT;
