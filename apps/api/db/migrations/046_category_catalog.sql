BEGIN;

-- Full category and subcategory catalogue for India Autism Center (P29).
-- Teams: IT = ...001, Admin = ...002, Projects = ...003 (fixed ids from migration 017).
-- Existing categories, subcategories and team mappings are kept as they are (ON CONFLICT DO NOTHING).

-- (category, handling team, owning teams)
CREATE TEMP TABLE category_seed ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('IT Hardware',                      '00000000-0000-4000-8000-000000000001'::uuid, ARRAY['00000000-0000-4000-8000-000000000001']::uuid[]),
  ('Audio Visual',                     '00000000-0000-4000-8000-000000000001'::uuid, ARRAY['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Office Equipment',                 '00000000-0000-4000-8000-000000000001'::uuid, ARRAY['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002']::uuid[]),
  ('Security & ELV',                   '00000000-0000-4000-8000-000000000001'::uuid, ARRAY['00000000-0000-4000-8000-000000000001']::uuid[]),
  ('Software License',                 '00000000-0000-4000-8000-000000000001'::uuid, ARRAY['00000000-0000-4000-8000-000000000001']::uuid[]),
  ('Clinical/Therapy Equipment',       '00000000-0000-4000-8000-000000000003'::uuid, ARRAY['00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Educational & Learning Materials', '00000000-0000-4000-8000-000000000003'::uuid, ARRAY['00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Sports & Recreation',              '00000000-0000-4000-8000-000000000003'::uuid, ARRAY['00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002']::uuid[]),
  ('Medical & First Aid',              '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Furniture',                        '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Electrical Equipment',             '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Kitchen Equipment',                '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Housekeeping & Cleaning',          '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002']::uuid[]),
  ('Heavy Machinery',                  '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002']::uuid[]),
  ('Mobility',                         '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']::uuid[]),
  ('Outdoor',                          '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002']::uuid[]),
  ('Vehicle',                          '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002']::uuid[]),
  ('Other',                            '00000000-0000-4000-8000-000000000002'::uuid, ARRAY['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']::uuid[])
) AS c(code, handling, owners)
-- Skip a category whose handling team no longer exists.
WHERE handling IN (SELECT id FROM teams);

INSERT INTO reference_values(kind, code, label)
SELECT 'CATEGORY', code, code FROM category_seed
ON CONFLICT (kind, code) DO NOTHING;

INSERT INTO category_policies(category_code, handling_team_id)
SELECT code, handling FROM category_seed
ON CONFLICT (category_code) DO NOTHING;

INSERT INTO category_teams(category_code, team_id)
SELECT s.code, owner
  FROM category_seed s CROSS JOIN LATERAL unnest(s.owners) AS owner
 WHERE owner IN (SELECT id FROM teams)
ON CONFLICT DO NOTHING;

-- Subcategories: (code, category, held by a person?)
-- "Held by a person" types need a custodian; the rest live in a room and need a location.
CREATE TEMP TABLE subcategory_seed(code text, category text, personal boolean) ON COMMIT DROP;
INSERT INTO subcategory_seed VALUES
  -- IT Hardware
  ('Laptop','IT Hardware',true),('Desktop','IT Hardware',true),('Monitor','IT Hardware',true),
  ('Tablet','IT Hardware',true),('Mobile Phone','IT Hardware',true),('Keyboard & Mouse','IT Hardware',true),
  ('Docking Station','IT Hardware',true),('External Storage','IT Hardware',true),('UPS','IT Hardware',false),
  ('Server','IT Hardware',false),
  -- Audio Visual
  ('Projector','Audio Visual',false),('Television','Audio Visual',false),('Speaker','Audio Visual',false),
  ('Microphone','Audio Visual',false),('Camera','Audio Visual',true),
  ('Video Conferencing Device','Audio Visual',false),('Smart Board','Audio Visual',false),
  -- Office Equipment
  ('Printer','Office Equipment',false),('Scanner','Office Equipment',false),
  ('Photocopier','Office Equipment',false),('Shredder','Office Equipment',false),
  ('Telephone','Office Equipment',false),('Laminator','Office Equipment',false),
  -- Security & ELV
  ('Networking','Security & ELV',false),('Wi-Fi Access Point','Security & ELV',false),
  ('CCTV Camera','Security & ELV',false),('NVR / DVR','Security & ELV',false),
  ('Access Control','Security & ELV',false),('Biometric Device','Security & ELV',false),
  ('Fire Alarm Panel','Security & ELV',false),
  -- Software License
  ('Operating System','Software License',false),('Productivity Suite','Software License',false),
  ('Antivirus','Software License',false),('Design Software','Software License',false),
  ('Clinical Software','Software License',false),('Cloud Subscription','Software License',false),
  -- Clinical/Therapy Equipment
  ('Sensory Integration Equipment','Clinical/Therapy Equipment',false),
  ('Therapy Swing','Clinical/Therapy Equipment',false),
  ('Balance & Gross Motor Equipment','Clinical/Therapy Equipment',false),
  ('Fine Motor Kit','Clinical/Therapy Equipment',false),
  ('Weighted Item','Clinical/Therapy Equipment',false),
  ('Speech Therapy Kit','Clinical/Therapy Equipment',false),
  ('Assessment Kit','Clinical/Therapy Equipment',false),
  ('Occupational Therapy Tool','Clinical/Therapy Equipment',false),
  ('Sensory Room Equipment','Clinical/Therapy Equipment',false),
  -- Educational & Learning Materials
  ('Learning Aid','Educational & Learning Materials',false),
  ('AAC Device','Educational & Learning Materials',true),
  ('Library Books','Educational & Learning Materials',false),
  ('Educational Toy','Educational & Learning Materials',false),
  ('Visual Schedule Board','Educational & Learning Materials',false),
  -- Sports & Recreation
  ('Sports Equipment','Sports & Recreation',false),('Musical Instrument','Sports & Recreation',false),
  ('Art & Craft Kit','Sports & Recreation',false),('Indoor Play Equipment','Sports & Recreation',false),
  -- Medical & First Aid
  ('First Aid Kit','Medical & First Aid',false),('BP Monitor','Medical & First Aid',false),
  ('Thermometer','Medical & First Aid',false),('Weighing Scale','Medical & First Aid',false),
  ('Pulse Oximeter','Medical & First Aid',false),('Oxygen Concentrator','Medical & First Aid',false),
  -- Furniture
  ('Chair','Furniture',false),('Table','Furniture',false),('Desk','Furniture',false),
  ('Cabinet','Furniture',false),('Bookshelf','Furniture',false),('Sofa','Furniture',false),
  ('Bed','Furniture',false),('Locker','Furniture',false),('Whiteboard','Furniture',false),
  ('Mat & Cushion','Furniture',false),
  -- Electrical Equipment
  ('Light','Electrical Equipment',false),('Fan','Electrical Equipment',false),
  ('Air Conditioner','Electrical Equipment',false),('Inverter','Electrical Equipment',false),
  ('Generator','Electrical Equipment',false),('Water Heater','Electrical Equipment',false),
  ('Air Purifier','Electrical Equipment',false),('Extension Board','Electrical Equipment',false),
  -- Kitchen Equipment
  ('Kitchen','Kitchen Equipment',false),('Refrigerator','Kitchen Equipment',false),
  ('Microwave','Kitchen Equipment',false),('Water Purifier','Kitchen Equipment',false),
  ('Induction Cooktop','Kitchen Equipment',false),('Gas Stove','Kitchen Equipment',false),
  ('Cookware','Kitchen Equipment',false),
  -- Housekeeping & Cleaning
  ('Vacuum Cleaner','Housekeeping & Cleaning',false),('Floor Scrubber','Housekeeping & Cleaning',false),
  ('Washing Machine','Housekeeping & Cleaning',false),('Cleaning Trolley','Housekeeping & Cleaning',false),
  -- Heavy Machinery
  ('Lift / Elevator','Heavy Machinery',false),('Water Pump','Heavy Machinery',false),
  ('Lawn Mower','Heavy Machinery',false),('Pressure Washer','Heavy Machinery',false),
  -- Mobility
  ('Wheelchair','Mobility',false),('Walker','Mobility',false),('Stroller','Mobility',false),
  ('Standing Frame','Mobility',false),
  -- Outdoor
  ('Playground Equipment','Outdoor',false),('Garden Tool','Outdoor',false),
  ('Outdoor Furniture','Outdoor',false),('Water Tank','Outdoor',false),
  -- Vehicle
  ('Car','Vehicle',false),('Van','Vehicle',false),('Bus','Vehicle',false),
  ('Two-wheeler','Vehicle',true);

INSERT INTO reference_values(kind, code, label)
SELECT 'ASSET_TYPE', code, code FROM subcategory_seed
ON CONFLICT (kind, code) DO NOTHING;

-- Owning/handling team of a subcategory follows its category's handling team.
INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code, owning_team_id, handling_team_id)
SELECT s.code, s.personal, s.category, p.handling_team_id, p.handling_team_id
  FROM subcategory_seed s
  JOIN category_policies p ON p.category_code = s.category
ON CONFLICT (asset_type_code) DO NOTHING;

COMMIT;
