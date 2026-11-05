BEGIN;

-- Category policies: each category has a handling team
CREATE TABLE category_policies(
  category_code text PRIMARY KEY CHECK(length(btrim(category_code)) BETWEEN 1 AND 100),
  handling_team_id uuid NOT NULL REFERENCES teams(id),
  version int NOT NULL DEFAULT 1 CHECK(version > 0)
);

-- Category teams: which teams own each category
CREATE TABLE category_teams(
  category_code text NOT NULL REFERENCES category_policies(category_code) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id),
  PRIMARY KEY (category_code, team_id)
);

-- Seed standard client categories (5 client groups: Heavy machinery, Furniture, IT, Outdoor, Mobility + more)
INSERT INTO category_policies(category_code,handling_team_id) VALUES
  ('Clinical/Therapy Equipment','00000000-0000-4000-8000-000000000003'),
  ('Electrical Equipment','00000000-0000-4000-8000-000000000002'),
  ('Furniture','00000000-0000-4000-8000-000000000002'),
  ('Heavy Machinery','00000000-0000-4000-8000-000000000002'),
  ('IT Hardware','00000000-0000-4000-8000-000000000001'),
  ('Kitchen Equipment','00000000-0000-4000-8000-000000000002'),
  ('Mobility','00000000-0000-4000-8000-000000000002'),
  ('Office Equipment','00000000-0000-4000-8000-000000000001'),
  ('Other','00000000-0000-4000-8000-000000000002'),
  ('Outdoor','00000000-0000-4000-8000-000000000002'),
  ('Security & ELV','00000000-0000-4000-8000-000000000001'),
  ('Software License','00000000-0000-4000-8000-000000000001'),
  ('Vehicle','00000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

-- Seed category → owning team mappings
INSERT INTO category_teams(category_code,team_id) VALUES
  ('Clinical/Therapy Equipment','00000000-0000-4000-8000-000000000003'),
  ('Electrical Equipment','00000000-0000-4000-8000-000000000002'),
  ('Electrical Equipment','00000000-0000-4000-8000-000000000003'),
  ('Furniture','00000000-0000-4000-8000-000000000002'),
  ('Furniture','00000000-0000-4000-8000-000000000003'),
  ('Heavy Machinery','00000000-0000-4000-8000-000000000002'),
  ('IT Hardware','00000000-0000-4000-8000-000000000001'),
  ('Kitchen Equipment','00000000-0000-4000-8000-000000000002'),
  ('Kitchen Equipment','00000000-0000-4000-8000-000000000003'),
  ('Mobility','00000000-0000-4000-8000-000000000002'),
  ('Office Equipment','00000000-0000-4000-8000-000000000001'),
  ('Other','00000000-0000-4000-8000-000000000002'),
  ('Other','00000000-0000-4000-8000-000000000003'),
  ('Outdoor','00000000-0000-4000-8000-000000000002'),
  ('Security & ELV','00000000-0000-4000-8000-000000000001'),
  ('Software License','00000000-0000-4000-8000-000000000001'),
  ('Vehicle','00000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

COMMIT;
