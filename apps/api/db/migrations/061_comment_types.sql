BEGIN;

-- Starting choices for an asset's "Comment type" (the list was empty, so only "Not set" showed).
-- The list stays editable in Master data under "Comment types"; existing values are kept.
INSERT INTO reference_values(kind, code, label) VALUES
  ('COMMENT_TYPE', 'General note', 'General note'),
  ('COMMENT_TYPE', 'Handover', 'Handover'),
  ('COMMENT_TYPE', 'Damage reported', 'Damage reported'),
  ('COMMENT_TYPE', 'Repair', 'Repair'),
  ('COMMENT_TYPE', 'Upgrade', 'Upgrade'),
  ('COMMENT_TYPE', 'Missing accessory', 'Missing accessory'),
  ('COMMENT_TYPE', 'Data wiped', 'Data wiped'),
  ('COMMENT_TYPE', 'Audit finding', 'Audit finding')
ON CONFLICT (kind, code) DO NOTHING;

COMMIT;
