BEGIN;

-- Add additional asset statuses used in the field
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;

ALTER TABLE assets ADD CONSTRAINT assets_status_check
  CHECK (status = ANY (ARRAY[
    'Active','In Store','Assigned','In Use','Ready to Assign','Broken',
    'Scrapped','Under Repair','Lost','Stolen','Retired','Disposed',
    'Leased','Under Verification','Sold'
  ]));

COMMIT;
