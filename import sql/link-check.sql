-- Read-only link check of the asset data. Safe to run on production: it only SELECTs.
--   psql ... -f "import sql/link-check.sql"
-- Each line: the check, how many records fail it, and up to 15 examples.
\pset footer off
WITH live AS (SELECT * FROM assets WHERE removed_at IS NULL),
open_asg AS (SELECT * FROM assignments WHERE ended_at IS NULL),
checks(n, area, problem, ids) AS (
  -- Custody
  -- Room equipment (TVs, CCTV, printers…) is In Use without a named holder; personal kit is not.
  SELECT 1, 'Custody', 'In Use but nobody holds it (kit that needs a holder)',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a
    JOIN asset_type_policies p ON p.asset_type_code = a.asset_type AND p.requires_custodian
    WHERE a.status IN ('In Use','Assigned') AND NOT EXISTS (SELECT 1 FROM open_asg g WHERE g.asset_id = a.id)
  UNION ALL SELECT 2, 'Custody', 'Someone holds it but status is not In Use',
    array_agg(a.asset_code || ' (' || a.status || ')' ORDER BY a.asset_code) FROM live a
    WHERE a.status NOT IN ('In Use','Assigned') AND EXISTS (SELECT 1 FROM open_asg g WHERE g.asset_id = a.id)
  UNION ALL SELECT 3, 'Custody', 'Held by more than one person at once',
    array_agg(code ORDER BY code) FROM (SELECT a.asset_code AS code FROM live a JOIN open_asg g ON g.asset_id = a.id
      GROUP BY a.asset_code HAVING count(*) > 1) x
  UNION ALL SELECT 4, 'Custody', 'Held by someone who has left',
    array_agg(a.asset_code || ' (' || u.display_name || ')' ORDER BY a.asset_code) FROM live a
    JOIN open_asg g ON g.asset_id = a.id JOIN users u ON u.id = g.user_id WHERE u.left_at IS NOT NULL
  UNION ALL SELECT 5, 'Custody', 'Held by a disabled or merged account',
    array_agg(a.asset_code || ' (' || u.display_name || ', ' || u.state || ')' ORDER BY a.asset_code) FROM live a
    JOIN open_asg g ON g.asset_id = a.id JOIN users u ON u.id = g.user_id
    WHERE u.merged_into_user_id IS NOT NULL OR u.state NOT IN ('ACTIVE','INVITED','DIRECTORY')
  UNION ALL SELECT 6, 'Custody', 'Removed asset still held by someone',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM assets a
    WHERE a.removed_at IS NOT NULL AND EXISTS (SELECT 1 FROM open_asg g WHERE g.asset_id = a.id)
  UNION ALL SELECT 7, 'Custody', 'Holder not confirmed yet',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a JOIN open_asg g ON g.asset_id = a.id
    WHERE g.acknowledgement = 'PENDING'
  UNION ALL SELECT 8, 'Custody', 'Holder reported a problem (disputed)',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a JOIN open_asg g ON g.asset_id = a.id
    WHERE g.acknowledgement = 'DISPUTED'
  -- Classification
  UNION ALL SELECT 10, 'Category', 'Category not in the category list (or switched off)',
    array_agg(a.asset_code || ' (' || a.category || ')' ORDER BY a.asset_code) FROM live a
    WHERE NOT EXISTS (SELECT 1 FROM reference_values r WHERE r.kind = 'CATEGORY' AND r.code = a.category AND r.active)
  UNION ALL SELECT 11, 'Category', 'Subcategory not in the list (or switched off)',
    array_agg(a.asset_code || ' (' || a.asset_type || ')' ORDER BY a.asset_code) FROM live a
    WHERE NOT EXISTS (SELECT 1 FROM reference_values r WHERE r.kind = 'ASSET_TYPE' AND r.code = a.asset_type AND r.active)
  UNION ALL SELECT 12, 'Category', 'Subcategory belongs to a different category',
    array_agg(a.asset_code || ' (' || a.category || ' / ' || a.asset_type || ')' ORDER BY a.asset_code) FROM live a
    JOIN asset_type_policies p ON p.asset_type_code = a.asset_type WHERE p.category_code IS NOT NULL AND p.category_code <> a.category
  UNION ALL SELECT 13, 'Category', 'Status not in the status list (or switched off)',
    array_agg(a.asset_code || ' (' || a.status || ')' ORDER BY a.asset_code) FROM live a
    WHERE NOT EXISTS (SELECT 1 FROM reference_values r WHERE r.kind = 'STATUS' AND r.code = a.status AND r.active)
  UNION ALL SELECT 14, 'Category', 'Condition not in the condition list',
    array_agg(a.asset_code || ' (' || a.condition || ')' ORDER BY a.asset_code) FROM live a
    WHERE NOT EXISTS (SELECT 1 FROM reference_values r WHERE r.kind = 'CONDITION' AND r.code = a.condition AND r.active)
  -- Teams
  UNION ALL SELECT 20, 'Team', 'No owning team',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.owning_team_id IS NULL
  UNION ALL SELECT 21, 'Team', 'Owning team is switched off',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a JOIN teams t ON t.id = a.owning_team_id WHERE NOT t.active
  UNION ALL SELECT 22, 'Team', 'Owning team does not handle this category',
    array_agg(a.asset_code || ' (' || t.code || ', ' || a.category || ')' ORDER BY a.asset_code) FROM live a
    JOIN teams t ON t.id = a.owning_team_id
    WHERE EXISTS (SELECT 1 FROM category_teams c WHERE c.category_code = a.category)
      AND NOT EXISTS (SELECT 1 FROM category_teams c WHERE c.category_code = a.category AND c.team_id = a.owning_team_id)
  UNION ALL SELECT 23, 'Team', 'Asset ID prefix does not match the owning team',
    array_agg(a.asset_code || ' (' || t.code || ')' ORDER BY a.asset_code) FROM live a JOIN teams t ON t.id = a.owning_team_id
    WHERE a.asset_code NOT LIKE 'IAC-' || t.asset_code_prefix || '-%'
  -- Places
  UNION ALL SELECT 30, 'Location', 'No location',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.location_id IS NULL
  UNION ALL SELECT 31, 'Location', 'Location is switched off',
    array_agg(a.asset_code || ' (' || l.name || ')' ORDER BY a.asset_code) FROM live a JOIN locations l ON l.id = a.location_id WHERE NOT l.active
  UNION ALL SELECT 32, 'Location', 'Location sits inside a switched-off place',
    array_agg(l.code ORDER BY l.code) FROM locations l JOIN locations p ON p.id = l.parent_id WHERE l.active AND NOT p.active
  UNION ALL SELECT 33, 'Department', 'Department is switched off',
    array_agg(a.asset_code || ' (' || d.name || ')' ORDER BY a.asset_code) FROM live a JOIN departments d ON d.id = a.department_id WHERE NOT d.active
  UNION ALL SELECT 34, 'Department', 'In store but still has a department',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.status = 'In Store' AND a.department_id IS NOT NULL
  UNION ALL SELECT 35, 'Department', 'Asset department differs from the holder''s department',
    array_agg(a.asset_code || ' (' || d.name || ' / ' || ud.name || ')' ORDER BY a.asset_code) FROM live a
    JOIN open_asg g ON g.asset_id = a.id JOIN users u ON u.id = g.user_id
    JOIN departments d ON d.id = a.department_id JOIN departments ud ON ud.id = u.department_id WHERE a.department_id <> u.department_id
  -- Identity
  UNION ALL SELECT 40, 'Identity', 'Same serial number on more than one asset',
    array_agg(codes ORDER BY codes) FROM (SELECT string_agg(a.asset_code, ' = ' ORDER BY a.asset_code) AS codes FROM live a
      WHERE nullif(btrim(a.serial_number), '') IS NOT NULL
      GROUP BY regexp_replace(lower(a.serial_number), '[^a-z0-9]', '', 'g') HAVING count(*) > 1) x
  UNION ALL SELECT 41, 'Identity', 'Kit part points to a removed or missing main asset',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a
    WHERE a.parent_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM live p WHERE p.id = a.parent_asset_id)
  -- Money
  UNION ALL SELECT 50, 'Finance', 'Finance approved but no purchase cost',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.finance_status = 'APPROVED' AND a.purchase_cost IS NULL
  UNION ALL SELECT 51, 'Finance', 'No purchase cost',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.purchase_cost IS NULL
  UNION ALL SELECT 52, 'Finance', 'Cost is zero',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.purchase_cost = 0
  UNION ALL SELECT 53, 'Finance', 'No purchase date',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.purchase_date IS NULL
  UNION ALL SELECT 54, 'Finance', 'Purchase date in the future',
    array_agg(a.asset_code || ' (' || a.purchase_date || ')' ORDER BY a.asset_code) FROM live a WHERE a.purchase_date > current_date
  UNION ALL SELECT 55, 'Finance', 'Capitalised before it was bought',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.capitalisation_date < a.purchase_date
  UNION ALL SELECT 56, 'Finance', 'Warranty ends before it was bought',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.warranty_expiry < a.purchase_date
  UNION ALL SELECT 57, 'Finance', 'Waiting for Finance review',
    array_agg(a.asset_code ORDER BY a.asset_code) FROM live a WHERE a.finance_status = 'PENDING'
  -- People and subscriptions
  UNION ALL SELECT 60, 'People', 'Current staff with no department',
    array_agg(u.display_name ORDER BY u.display_name) FROM users u
    WHERE u.state = 'ACTIVE' AND u.left_at IS NULL AND u.merged_into_user_id IS NULL AND u.department_id IS NULL
  UNION ALL SELECT 61, 'People', 'Person in a switched-off department',
    array_agg(u.display_name || ' (' || d.name || ')' ORDER BY u.display_name) FROM users u JOIN departments d ON d.id = u.department_id
    WHERE NOT d.active AND u.left_at IS NULL AND u.merged_into_user_id IS NULL
  UNION ALL SELECT 62, 'People', 'Same email on two accounts',
    array_agg(e ORDER BY e) FROM (SELECT lower(email) AS e FROM users WHERE merged_into_user_id IS NULL GROUP BY 1 HAVING count(*) > 1) x
  UNION ALL SELECT 63, 'Subscriptions', 'Subscription seat held by someone who has left',
    array_agg(s.name || ' (' || u.display_name || ')' ORDER BY s.name) FROM subscription_assignments sa
    JOIN subscriptions s ON s.id = sa.subscription_id JOIN users u ON u.id = sa.user_id
    WHERE sa.ended_at IS NULL AND (u.left_at IS NOT NULL OR u.merged_into_user_id IS NOT NULL)
  UNION ALL SELECT 64, 'Subscriptions', 'More seats given than bought',
    array_agg(name ORDER BY name) FROM (SELECT s.name FROM subscriptions s JOIN subscription_assignments sa ON sa.subscription_id = s.id AND sa.ended_at IS NULL
      WHERE s.seats_total IS NOT NULL GROUP BY s.id, s.name, s.seats_total HAVING count(*) > s.seats_total) x
  -- Support
  UNION ALL SELECT 70, 'Support', 'Open ticket on a removed asset',
    array_agg('#' || t.ticket_number ORDER BY t.ticket_number) FROM tickets t JOIN assets a ON a.id = t.asset_id
    WHERE a.removed_at IS NOT NULL AND t.status <> 'COMPLETED'
  UNION ALL SELECT 71, 'Support', 'Open ticket owned by someone who has left',
    array_agg('#' || t.ticket_number ORDER BY t.ticket_number) FROM tickets t JOIN users u ON u.id = t.owner_id
    WHERE t.status <> 'COMPLETED' AND u.left_at IS NOT NULL
)
SELECT n AS "#", area, problem, coalesce(array_length(ids, 1), 0) AS count,
       array_to_string(ids[1:15], ', ') || CASE WHEN array_length(ids, 1) > 15 THEN ', …' ELSE '' END AS examples
  FROM checks ORDER BY n;
