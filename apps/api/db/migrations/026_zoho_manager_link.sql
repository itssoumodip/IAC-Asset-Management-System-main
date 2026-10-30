-- Zoho People: link manager_name to actual user records via manager_id FK.
BEGIN;

ALTER TABLE users
  ADD COLUMN manager_id uuid REFERENCES users(id);

COMMIT;
