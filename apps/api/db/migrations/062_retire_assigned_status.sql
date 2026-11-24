BEGIN;

-- "Assigned" and "In Use" mean the same thing: someone holds the asset. Assignment has written
-- "In Use" since migration 029, so "Assigned" only lingers on older rows and showed twice in the
-- status list. Move those rows to "In Use" and hide "Assigned" from new choices. The value is kept
-- (inactive, and still allowed by the column check) so history and old audit entries still read.
UPDATE assets SET status = 'In Use', version = version + 1, updated_at = now()
WHERE status = 'Assigned';

-- Fixed kinds must stay active; "Assigned" is the one retired status allowed to be inactive.
ALTER TABLE reference_values DROP CONSTRAINT fixed_reference_active;
ALTER TABLE reference_values ADD CONSTRAINT fixed_reference_active CHECK (
  kind NOT IN ('STATUS', 'TICKET_PRIORITY', 'TICKET_STATUS', 'DATA_WIPE')
  OR active
  OR (kind = 'STATUS' AND code = 'Assigned')
);

UPDATE reference_values SET active = false, version = version + 1
WHERE kind = 'STATUS' AND code = 'Assigned' AND active;

COMMIT;
