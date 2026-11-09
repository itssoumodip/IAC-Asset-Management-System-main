BEGIN;

-- Finance-targeted in-app notices for newly registered assets.
ALTER TABLE in_app_announcements DROP CONSTRAINT IF EXISTS in_app_announcements_audience_check;
ALTER TABLE in_app_announcements ADD CONSTRAINT in_app_announcements_audience_check
  CHECK (audience IN ('ALL', 'ADMIN', 'DEPARTMENT', 'FINANCE'));

-- Statuses allowed by migration 029 but missing from the STATUS master list.
INSERT INTO reference_values(kind,code,label)
SELECT 'STATUS',code,code FROM unnest(ARRAY['In Use','Ready to Assign','Broken','Scrapped']) AS t(code)
ON CONFLICT DO NOTHING;

COMMIT;
