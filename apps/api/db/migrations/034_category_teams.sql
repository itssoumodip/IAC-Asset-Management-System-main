BEGIN;

CREATE TABLE category_policies(
  category_code text PRIMARY KEY,
  handling_team_id uuid NOT NULL REFERENCES teams(id),
  version int NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE category_teams(
  category_code text NOT NULL REFERENCES category_policies(category_code) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id),
  PRIMARY KEY (category_code, team_id)
);

ALTER TABLE asset_type_policies
  ADD COLUMN category_code text REFERENCES category_policies(category_code);

INSERT INTO reference_values(kind,code,label) VALUES
  ('ASSET_TYPE','Chair','Chair'),
  ('ASSET_TYPE','Table','Table'),
  ('ASSET_TYPE','Kitchen','Kitchen appliance'),
  ('ASSET_TYPE','Light','Light')
ON CONFLICT DO NOTHING;

INSERT INTO category_policies(category_code, handling_team_id) VALUES
  ('IT Hardware', '00000000-0000-4000-8000-000000000001'),
  ('Software License', '00000000-0000-4000-8000-000000000001'),
  ('Security & ELV', '00000000-0000-4000-8000-000000000001'),
  ('Office Equipment', '00000000-0000-4000-8000-000000000001'),
  ('Furniture', '00000000-0000-4000-8000-000000000002'),
  ('Kitchen Equipment', '00000000-0000-4000-8000-000000000002'),
  ('Electrical Equipment', '00000000-0000-4000-8000-000000000002'),
  ('Vehicle', '00000000-0000-4000-8000-000000000002'),
  ('Clinical/Therapy Equipment', '00000000-0000-4000-8000-000000000003'),
  ('Other', '00000000-0000-4000-8000-000000000002'),
  ('Heavy Machinery', '00000000-0000-4000-8000-000000000002'),
  ('Outdoor', '00000000-0000-4000-8000-000000000002'),
  ('Mobility', '00000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

INSERT INTO category_teams(category_code, team_id)
SELECT category_code, handling_team_id FROM category_policies
ON CONFLICT DO NOTHING;

INSERT INTO category_teams(category_code, team_id)
SELECT category_code, '00000000-0000-4000-8000-000000000003'
FROM category_policies
WHERE category_code IN ('Furniture','Kitchen Equipment','Electrical Equipment','Other')
ON CONFLICT DO NOTHING;

UPDATE asset_type_policies SET category_code = CASE asset_type_code
  WHEN 'Laptop' THEN 'IT Hardware'
  WHEN 'Desktop' THEN 'IT Hardware'
  WHEN 'Monitor' THEN 'IT Hardware'
  WHEN 'Networking' THEN 'IT Hardware'
  WHEN 'Printer' THEN 'Office Equipment'
  WHEN 'Chair' THEN 'Furniture'
  WHEN 'Table' THEN 'Furniture'
  WHEN 'Kitchen' THEN 'Kitchen Equipment'
  WHEN 'Light' THEN 'Electrical Equipment'
  ELSE category_code
END;

INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code)
VALUES ('Other', false, 'Other')
ON CONFLICT (asset_type_code) DO UPDATE
SET category_code = excluded.category_code;

COMMIT;
