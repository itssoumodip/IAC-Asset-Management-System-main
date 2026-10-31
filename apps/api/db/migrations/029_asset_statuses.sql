BEGIN;

ALTER TABLE assets DROP CONSTRAINT assets_status_check;
ALTER TABLE assets ADD CONSTRAINT assets_status_check CHECK (
  status IN (
    'Active','In Store','Assigned','In Use','Ready to Assign','Broken','Scrapped',
    'Under Repair','Lost','Stolen','Retired','Disposed','Leased','Under Verification','Sold'
  )
);
INSERT INTO reference_values(kind,code,label)
SELECT 'STATUS', code, code
FROM unnest(ARRAY['Ready to Assign','In Use','Scrapped','Broken']) AS status(code)
ON CONFLICT (kind,code) DO NOTHING;

COMMIT;
