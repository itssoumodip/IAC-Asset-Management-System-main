-- IT asset register: follow-up update (generated). Run once, after it-register-import.sql.
-- Adds: location tree + asset locations, previous holders as past custody, history entries,
-- current holders that were not found on the first run, and the GStartCAD software licence.
-- Writes NO email, push or in-app notifications.
\set ON_ERROR_STOP on
BEGIN;

DO $$ BEGIN
  IF (SELECT count(*) FROM assets WHERE asset_code LIKE 'IAC-IT-%') < 170 THEN
    RAISE EXCEPTION 'Run it-register-import.sql first (IT register assets not found).';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_events WHERE action='IT_REGISTER_UPDATED') THEN
    RAISE EXCEPTION 'This update was already applied.';
  END IF;
END $$;

UPDATE email_deliveries SET state='DEAD', last_error_code='SUPPRESSED', leased_until=NULL, lease_token=NULL
 WHERE state IN ('PENDING','LEASED');

CREATE TEMP TABLE importer ON COMMIT DROP AS
  SELECT ur.user_id AS id FROM user_roles ur WHERE ur.role_code='SUPER_ADMIN' ORDER BY ur.granted_at LIMIT 1;

-- Find a person by employee code, else by exact name (current, not merged/left people first).
CREATE FUNCTION pg_temp.person(p_code text, p_name text) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT u.id FROM users u
   WHERE (p_code IS NOT NULL AND upper(btrim(u.employee_code)) = upper(btrim(p_code)))
      OR (p_code IS NULL AND lower(btrim(u.display_name)) = lower(btrim(p_name)))
   ORDER BY (u.left_at IS NULL) DESC, (u.state='ACTIVE') DESC LIMIT 1
$f$;

CREATE TEMP TABLE reg(asset_code text, holder_code text, loc_code text, prev jsonb, prev_unmatched text,
  remarks text, purchase_date date, sheet_status text) ON COMMIT DROP;
INSERT INTO reg VALUES
('IAC-IT-000001', 'E0071', 'IAC-SITE-SIRAKOL', '[]', 'Amit Chakraborty', 'Previous holder(s) not in Zoho: Amit Chakraborty', '2022-03-08', 'Assigned'),
('IAC-IT-000002', 'IAC0008', 'IAC-HO-2F-NSCABIN', '[]', NULL, 'Previous holder on sheet: Nishant Shah', '2022-03-08', 'Assigned'),
('IAC-IT-000003', NULL, 'IAC-HO-3F', '[]', NULL, NULL, '2022-03-21', 'Assigned'),
('IAC-IT-000004', 'E0130', 'IAC-HO-GF', '[{"name":"Sreerupa Chakrabarty","code":"E0064"}]', 'Sanya Rohra', 'Previous holder(s) not in Zoho: Sanya Rohra', '2022-05-10', 'Assigned'),
('IAC-IT-000005', 'E0014', 'IAC-HO-GF', '[{"name":"Shamim Akhtar","code":"E0023"}]', NULL, NULL, '2022-10-18', 'Assigned'),
('IAC-IT-000006', NULL, 'IAC-HO-3F', '[]', 'Arup Chakraborty', 'IAC to Research Team | Sheet holder: Research Team (Handed Over to Ipsita and Kiran) (E0047) | Previous holder(s) not in Zoho: Arup Chakraborty', '2022-11-04', 'Assigned'),
('IAC-IT-000007', 'IAC0008', 'IAC-HO-3F', '[]', NULL, 'NS Old Laptop | Previous holder on sheet: Nishant Shah', '2022-11-03', 'Assigned'),
('IAC-IT-000008', NULL, 'IAC-HO-3F', '[]', 'Ipsita Dey', 'Sheet holder: IT Stock (E0007) | Previous holder(s) not in Zoho: Ipsita Dey', '2023-01-12', 'Assigned'),
('IAC-IT-000009', 'E0087', 'IAC-HO-3F', '[{"name":"Animesh Chakraborty","code":"E0116"}]', NULL, NULL, '2023-02-13', 'Assigned'),
('IAC-IT-000010', NULL, 'IAC-HO-3F', '[]', 'Sarmistha Bhattacharya', 'Sheet holder: IT Stock | Previous holder(s) not in Zoho: Sarmistha Bhattacharya', '2023-03-27', 'Assigned'),
('IAC-IT-000011', NULL, 'IAC-HO-2F', '[]', 'Avijit dutta', 'Sheet holder: Mini Gourisaria (E0118) | Previous holder(s) not in Zoho: Avijit dutta', '2024-09-05', 'Assigned'),
('IAC-IT-000012', 'E0054', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Trishita Chakrabarty', '2024-06-13', 'Assigned'),
('IAC-IT-000013', 'E0150', 'IAC-SITE-GF', '[]', 'Ujjawal Galada', 'Previous holder(s) not in Zoho: Ujjawal Galada', '2024-05-21', 'Assigned'),
('IAC-IT-000014', 'E0144', 'IAC-HO-GF', '[{"name":"Gaurav Arora","code":"E0127"}]', NULL, NULL, '2024-05-06', 'Assigned'),
('IAC-IT-000015', NULL, 'IAC-HO-2F', '[]', NULL, 'Sheet holder: Sweta Agarwal (E0051) | Previous holder on sheet: Sweta Agarwal', '2024-04-09', 'Assigned'),
('IAC-IT-000016', 'E0120', 'IAC-HO-GF', '[]', 'Raunak Kachhwaha', 'Previous holder(s) not in Zoho: Raunak Kachhwaha', '2024-03-26', 'Assigned'),
('IAC-IT-000017', 'E0049', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Puja Dutta', '2024-03-26', 'Assigned'),
('IAC-IT-000018', 'E0050', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Trisha Chakraborty', '2024-03-26', 'Assigned'),
('IAC-IT-000019', 'E0047', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Kiran Tomer', '2024-03-05', 'Assigned'),
('IAC-IT-000020', 'E0045', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Shaireen Ali', '2024-02-28', 'Assigned'),
('IAC-IT-000021', 'E0025', 'IAC-HO-2F', '[]', 'Sulagna Chakrabarty', 'Previous holder(s) not in Zoho: Sulagna Chakrabarty', '2024-01-30', 'Assigned'),
('IAC-IT-000022', 'E0098', 'IAC-HO-GF', '[]', 'Nabanita Acharjee', 'Previous holder(s) not in Zoho: Nabanita Acharjee', '2023-12-20', 'Assigned'),
('IAC-IT-000023', 'E0081', 'IAC-HO-3F', '[]', 'Pritha', 'Previous holder(s) not in Zoho: Pritha', '2023-10-09', 'Assigned'),
('IAC-IT-000024', NULL, NULL, '[]', NULL, 'As per jai Sir approval this laptop sold to UKC | Previous holder on sheet: UKC', '2023-10-04', 'Sold'),
('IAC-IT-000025', 'E0149', 'IAC-HO-GF', '[]', 'Uday samanta, Tanima Chakraborty', 'Previous holder(s) not in Zoho: Uday samanta, Tanima Chakraborty', '2023-08-28', 'Assigned'),
('IAC-IT-000026', 'E0039', 'IAC-HO-GF', '[]', 'Lovelina Banerjee', 'Previous holder(s) not in Zoho: Lovelina Banerjee', '2023-08-01', 'Assigned'),
('IAC-IT-000027', 'E0134', 'IAC-HO-3F', '[]', 'Ritika Verma, Satyendra', 'Previous holder(s) not in Zoho: Ritika Verma, Satyendra', '2023-07-16', 'Assigned'),
('IAC-IT-000028', 'E0061', 'IAC-HO-GF', '[]', 'Shanta Kumar Biswas', 'BILL IN PATRONS | Previous holder(s) not in Zoho: Shanta Kumar Biswas', '2024-12-09', 'Assigned'),
('IAC-IT-000029', NULL, 'IAC-HO', '[]', 'Sudipta Pal', 'BILL IN PATRONS | Sheet holder: IAC Research Team | Previous holder(s) not in Zoho: Sudipta Pal', '2024-12-09', 'Assigned'),
('IAC-IT-000030', 'E0096', 'IAC-HO-3F', '[{"name":"Tehiya Das","code":"E0061"}]', NULL, NULL, '2024-11-25', 'Assigned'),
('IAC-IT-000031', 'E0117', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Eshaa Munder', '2024-11-15', 'Assigned'),
('IAC-IT-000032', 'E0060', 'IAC-SITE-SIRAKOL', '[]', NULL, 'Previous holder on sheet: Manas Maity', '2024-11-13', 'Assigned'),
('IAC-IT-000033', 'E0123', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Anushree (HR Intern)', '2024-11-13', 'Assigned'),
('IAC-IT-000034', NULL, 'IAC-HO-3F', '[]', NULL, 'Water logging issues | Previous holder on sheet: Sharmishtha Raja', '2024-10-15', 'Disposed'),
('IAC-IT-000035', NULL, NULL, '[]', NULL, NULL, '2024-10-03', 'Disposed'),
('IAC-IT-000036', NULL, 'IAC-HO-GF', '[]', 'Dr. Ritwika Basu, Disha Pandey', 'Sheet holder: Devendra Kumar | Previous holder(s) not in Zoho: Dr. Ritwika Basu, Disha Pandey', NULL, 'Assigned'),
('IAC-IT-000037', 'E0126', NULL, '[]', NULL, 'Previous holder on sheet: Amit Kumar Saha', NULL, 'Assigned'),
('IAC-IT-000038', NULL, 'IAC-HO-3F', '[]', NULL, 'Sheet holder: Roshnee Bhomik | Previous holder on sheet: Roshnee Bhomik', '2026-01-29', 'Assigned'),
('IAC-IT-000039', NULL, 'IAC-HO-3F', '[]', NULL, 'Sheet holder: Clinical Team AND Research Team | Previous holder on sheet: Clinical Team AND Research Team', '2026-02-09', 'Assigned'),
('IAC-IT-000040', 'IAC0008', 'IAC-HO-2F', '[]', NULL, 'Previous holder on sheet: Nishant Shah', '2026-05-02', 'Assigned'),
('IAC-IT-000041', 'E0152', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Payel Debnath', '2026-05-13', 'Assigned'),
('IAC-IT-000042', NULL, 'IAC-HO-GF', '[]', NULL, 'Sheet holder: Dr. Nandita Ghose | Previous holder on sheet: Dr. Nandita Ghose', '2026-05-13', 'Assigned'),
('IAC-IT-000043', NULL, 'IAC-HO-3F', '[]', NULL, 'Sheet holder: Souradeep Sinh | Previous holder on sheet: Stock from Sreerupa and sreerupa old laptop to research intern', '2026-01-13', 'Assigned'),
('IAC-IT-000044', NULL, 'IAC-HO-GF', '[]', NULL, 'Sheet holder: Prinyanka Mahato | Previous holder on sheet: Prinyanka Mahato', '2026-01-07', 'Assigned'),
('IAC-IT-000045', 'E0140', 'IAC-HO-3F', '[]', 'Paridhi', 'Previous holder(s) not in Zoho: Paridhi', '2026-01-07', 'Assigned'),
('IAC-IT-000046', 'E0108', 'IAC-SITE-CAMPUS', '[]', NULL, 'Previous holder on sheet: Shantanu Chaudhary', '2026-01-13', 'Assigned'),
('IAC-IT-000047', 'E0151', 'IAC-HO-GF', '[{"name":"Abhik Ghosh","code":"E0140"}]', 'Sampreeti', 'Previous holder(s) not in Zoho: Sampreeti', '2025-06-16', 'Assigned'),
('IAC-IT-000048', 'E0073', 'IAC-HO-2F', '[]', NULL, 'Previous holder on sheet: Anisha Singh', '2025-06-16', 'Assigned'),
('IAC-IT-000049', 'E0127', 'IAC-HO-3F', '[]', 'Mukut Mukherjee, Siddhart Agarwal', 'Previous holder(s) not in Zoho: Mukut Mukherjee, Siddhart Agarwal', '2025-03-25', 'Assigned'),
('IAC-IT-000050', 'E0008', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Barnali Sardar', '2025-07-31', 'Assigned'),
('IAC-IT-000051', 'E0101', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Sourav Mondal', '2025-08-10', 'Assigned'),
('IAC-IT-000052', 'E0085', 'IAC-HO-3F', '[]', 'Siddharth Agarwal', 'Previous holder(s) not in Zoho: Siddharth Agarwal', NULL, 'Assigned'),
('IAC-IT-000053', 'E0100', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Anindita Sinha', '2025-08-10', 'Assigned'),
('IAC-IT-000054', 'E0058', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Sharmistha Raja', '2025-08-10', 'Assigned'),
('IAC-IT-000055', 'E0109', 'IAC-HO-GF', '[{"name":"Barnali Sardar","code":"E0008"}]', NULL, 'NOT IN THE IAC BOOKS PURCHASED FROM RATNABALI', NULL, 'Assigned'),
('IAC-IT-000056', 'E0137', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Aparajita Saha', '2026-07-14', 'Assigned'),
('IAC-IT-000057', 'E0094', 'IAC-HO-GF', '[]', 'Abheepsa Bagchi', 'Previous holder(s) not in Zoho: Abheepsa Bagchi', '2025-06-16', 'Assigned'),
('IAC-IT-000058', 'E0113', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Sutapa Bose', '2025-11-18', 'Assigned'),
('IAC-IT-000059', 'E0138', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Sreetama Bhaduri', '2026-07-14', 'Assigned'),
('IAC-IT-000060', NULL, 'IAC-HO', '[]', NULL, NULL, NULL, 'Assigned'),
('IAC-IT-000061', 'E0121', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Priyanka Mahato', '2025-01-07', 'Assigned'),
('IAC-IT-000062', 'E0145', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Simran Sultana', '2026-05-13', 'Assigned'),
('IAC-IT-000063', 'E0133', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Srayosi Hazra', NULL, 'Assigned'),
('IAC-IT-000064', NULL, 'IAC-HO-3F', '[{"name":"Nishant Shah","code":"IAC0008"}]', NULL, 'Sheet holder: Sreerupa Chakraborty', '2025-10-17', 'Assigned'),
('IAC-IT-000065', 'E0059', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Sourav Bose', '2025-03-25', 'Assigned'),
('IAC-IT-000066', 'E0104', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Anubhav Das', '2025-12-16', 'Assigned'),
('IAC-IT-000067', NULL, 'IAC-HO-3F', '[]', 'Uday samanta, Kamal Rathi', 'Sheet holder: Miti Sengupta | Previous holder(s) not in Zoho: Uday samanta, Kamal Rathi', '2022-03-21', 'Assigned'),
('IAC-IT-000068', 'E0125', 'IAC-HO-3F', '[]', 'Siddharth Agarwal', 'Previous holder(s) not in Zoho: Siddharth Agarwal', '2025-05-16', 'Assigned'),
('IAC-IT-000069', NULL, 'IAC-HO-3F', '[]', NULL, 'Sheet holder: Research Team | Previous holder on sheet: Research Team', NULL, 'Assigned'),
('IAC-IT-000070', 'E0079', 'IAC-HO-3F', '[]', NULL, 'Previous holder on sheet: Vartika Arora', '2026-05-13', 'Assigned'),
('IAC-IT-000071', 'E0051', 'IAC-HO-2F', '[]', NULL, 'Previous holder on sheet: Jay Prakash Lahoti', NULL, 'Assigned'),
('IAC-IT-000072', NULL, 'IAC-HO', '[]', NULL, 'Sheet holder: Devdeep Roy | Previous holder on sheet: Devdeep Roy', NULL, 'Assigned'),
('IAC-IT-000073', 'E0110', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Debasmita Saha', '2025-08-10', 'Assigned'),
('IAC-IT-000074', 'E0111', 'IAC-HO-GF', '[]', NULL, 'Previous holder on sheet: Debaleena Saha', '2025-08-10', 'Assigned'),
('IAC-IT-000075', 'E0063', NULL, '[]', NULL, 'Previous holder on sheet: Diptyarka Bose', '2025-11-10', NULL),
('IAC-IT-000076', 'E0012', NULL, '[{"name":"Nishant Shah","code":"IAC0008"}]', NULL, NULL, NULL, NULL),
('IAC-IT-000077', NULL, NULL, '[]', NULL, 'Sheet holder: Chayan Mondal | Previous holder on sheet: Chayan Mondal', '2025-07-02', NULL),
('IAC-IT-000078', NULL, NULL, '[]', NULL, 'Sheet holder: Ashmita Bandyopadhyay (E0119) | Previous holder on sheet: Ashmita Bandyopadhyay', '2026-05-13', NULL),
('IAC-IT-000079', 'E0132', NULL, '[]', NULL, 'Previous holder on sheet: Probhas Das', '2026-05-13', NULL),
('IAC-IT-000080', 'IAC0009', NULL, '[]', NULL, 'Previous holder on sheet: Prithwis Kumar Banerjee', '2021-04-20', NULL),
('IAC-IT-000081', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000082', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000083', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000084', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000085', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000086', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000087', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000088', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000089', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000090', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000091', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000092', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000093', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000094', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000095', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000096', NULL, 'IAC-SITE', '[]', NULL, 'For Ayan Desktop at Site | Sheet holder: Campus | Previous holder on sheet: Campus', '2026-09-22', 'Active'),
('IAC-IT-000097', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: HNYOW53R | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-09', 'Active'),
('IAC-IT-000098', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: HNYOW55W | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-09', 'Active'),
('IAC-IT-000099', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: ZHA2DK5DL | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-16', 'Active'),
('IAC-IT-000100', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: HA2DMQCK | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-16', 'Active'),
('IAC-IT-000101', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: HA2DJWZE | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-16', 'Active'),
('IAC-IT-000102', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: | Sheet holder: clinical | Previous holder on sheet: clinical', '2026-09-18', 'Active'),
('IAC-IT-000103', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-18', 'Active'),
('IAC-IT-000104', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-18', 'Active'),
('IAC-IT-000105', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-18', 'Active'),
('IAC-IT-000106', NULL, 'IAC-HO', '[]', NULL, 'App Store login Details
Username: - indiaautismcenter@gmail.com
Password: Shamim#22
D.O.B: 22/02/1993
SN: | Sheet holder: Clinical | Previous holder on sheet: Clinical', '2026-09-18', 'Active'),
('IAC-IT-000107', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000108', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000109', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000110', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000111', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000112', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000113', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000114', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000115', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000116', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000117', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000118', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000119', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000120', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000121', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000122', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000123', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000124', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000125', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000126', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000127', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000128', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000129', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000130', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000131', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000132', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000133', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000134', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000135', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000136', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000137', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000138', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000139', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000140', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000141', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000142', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000143', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000144', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000145', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000146', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000147', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000148', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000149', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000150', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000151', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000152', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000153', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000154', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000155', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000156', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000157', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000158', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000159', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000160', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000161', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000162', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000163', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000164', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000165', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000166', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000167', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000168', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000169', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000170', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000171', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000172', NULL, NULL, '[]', NULL, NULL, NULL, NULL),
('IAC-IT-000173', NULL, NULL, '[]', NULL, NULL, NULL, NULL);

-- 1. Location tree (parents first; existing codes are reused).
CREATE TEMP TABLE loc_seed(code text, name text, level text, parent_code text, ord serial) ON COMMIT DROP;
INSERT INTO loc_seed(code, name, level, parent_code) VALUES
  ('IAC-HO', 'Head Office (HO)', 'SITE', NULL),
  ('IAC-HO-GF', 'Ground Floor', 'FLOOR', 'IAC-HO'),
  ('IAC-HO-2F', '2nd Floor', 'FLOOR', 'IAC-HO'),
  ('IAC-HO-3F', '3rd Floor', 'FLOOR', 'IAC-HO'),
  ('IAC-HO-2F-NSCABIN', 'NS Cabin', 'UNIT', 'IAC-HO-2F'),
  ('IAC-SITE', 'Project Site', 'SITE', NULL),
  ('IAC-SITE-GF', 'Ground Floor', 'FLOOR', 'IAC-SITE'),
  ('IAC-SITE-SIRAKOL', 'Sirakol', 'ZONE', 'IAC-SITE'),
  ('IAC-SITE-CAMPUS', 'Campus', 'ZONE', 'IAC-SITE');
DO $$ DECLARE s record; BEGIN
  FOR s IN SELECT * FROM loc_seed ORDER BY ord LOOP
    IF NOT EXISTS (SELECT 1 FROM locations WHERE code = s.code) THEN
      INSERT INTO locations(code, site, name, level, parent_id)
      VALUES (s.code, s.name, s.name, s.level, (SELECT id FROM locations WHERE code = s.parent_code));
    END IF;
  END LOOP;
END $$;

-- 2. Link assets to their location and record it in history.
WITH linked AS (
  UPDATE assets a SET location_id = l.id, updated_at = now(), version = a.version + 1
  FROM reg r JOIN locations l ON l.code = r.loc_code
  WHERE a.asset_code = r.asset_code AND a.location_id IS NULL
  RETURNING a.id, l.id AS loc_id
)
INSERT INTO asset_movements(asset_id, kind, to_location_id, reason, actor_id)
SELECT id, 'RELOCATE', loc_id, 'Location from the IT asset register', (SELECT id FROM importer) FROM linked;

-- 3. Current holders that could not be found on the first run (people synced from Zoho since).
WITH todo AS (
  SELECT a.id AS asset_id, pg_temp.person(r.holder_code, NULL) AS user_id
  FROM reg r JOIN assets a ON a.asset_code = r.asset_code
  WHERE r.holder_code IS NOT NULL
    AND a.status NOT IN ('Disposed','Sold','Retired','Scrapped','Lost','Stolen')
    AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.ended_at IS NULL)
), made AS (
  INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, acknowledgement, acknowledged_at, handover_note)
  SELECT asset_id, user_id, (SELECT id FROM importer), now(), 'ACCEPTED', now(), 'Imported from the IT asset register'
  FROM todo WHERE user_id IS NOT NULL
  RETURNING asset_id
)
UPDATE assets a SET status = 'In Use', updated_at = now(), version = a.version + 1
FROM made WHERE a.id = made.asset_id;

-- 4. Remarks: rebuilt from the sheet (location and holders now live in their own places).
UPDATE assets a SET remarks = concat_ws(' | ', nullif(r.remarks, ''),
    CASE WHEN r.holder_code IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.ended_at IS NULL)
          AND a.status NOT IN ('Disposed','Sold')
         THEN 'Holder code ' || r.holder_code || ' not found in Zoho here' END)
FROM reg r WHERE a.asset_code = r.asset_code;

-- 5. Previous holders: past custody (oldest first) ending before the current holder.
DO $$ DECLARE r record; p jsonb; i int; n int; uid uuid; aid uuid; base timestamptz; stop timestamptz; s_at timestamptz; e_at timestamptz; new_id uuid;
BEGIN
  FOR r IN SELECT g.*, a.id AS asset_id FROM reg g JOIN assets a ON a.asset_code = g.asset_code
           WHERE jsonb_array_length(g.prev) > 0 LOOP
    SELECT min(assigned_at) INTO stop FROM assignments WHERE asset_id = r.asset_id;
    stop := least(coalesce(stop, now()), now());
    base := coalesce(r.purchase_date::timestamptz, stop - interval '1 day');
    IF base >= stop THEN base := stop - interval '1 day'; END IF;
    n := jsonb_array_length(r.prev);
    FOR i IN 0 .. n - 1 LOOP
      p := r.prev -> i;
      uid := pg_temp.person(p->>'code', p->>'name');
      CONTINUE WHEN uid IS NULL;
      s_at := base + (stop - base) * i / n;
      e_at := base + (stop - base) * (i + 1) / n - interval '1 second';
      IF e_at < s_at THEN e_at := s_at; END IF;
      INSERT INTO assignments(asset_id, user_id, assigned_by, assigned_at, ended_at, ended_by, acknowledgement, acknowledged_at, handover_note)
      VALUES (r.asset_id, uid, (SELECT id FROM importer), s_at, e_at, (SELECT id FROM importer), 'ACCEPTED', s_at,
              'Previous holder from the IT asset register (exact dates not recorded)')
      RETURNING id INTO new_id;
      INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id, occurred_at)
      VALUES (r.asset_id, 'ASSIGN', new_id, 'Held by ' || (p->>'name') || ' (previous holder, from the IT asset register)', (SELECT id FROM importer), s_at);
      INSERT INTO asset_movements(asset_id, kind, from_assignment_id, reason, actor_id, occurred_at)
      VALUES (r.asset_id, 'RETURN', new_id, 'Handed on by ' || (p->>'name') || ' (from the IT asset register)', (SELECT id FROM importer), e_at);
    END LOOP;
  END LOOP;
END $$;

-- 6. History for current custody (assignments without a history entry yet).
INSERT INTO asset_movements(asset_id, kind, to_assignment_id, reason, actor_id, occurred_at)
SELECT s.asset_id, 'ASSIGN', s.id, 'Assigned to ' || u.display_name || ' (from the IT asset register)', (SELECT id FROM importer), s.assigned_at
FROM assignments s JOIN users u ON u.id = s.user_id JOIN assets a ON a.id = s.asset_id
WHERE s.ended_at IS NULL AND a.asset_code LIKE 'IAC-IT-%'
  AND NOT EXISTS (SELECT 1 FROM asset_movements m WHERE m.to_assignment_id = s.id);
INSERT INTO assignment_events(assignment_id, actor_id, kind, details, occurred_at)
SELECT s.id, (SELECT id FROM importer), 'ASSIGNED', '{"source":"IT asset register"}'::jsonb, s.assigned_at
FROM assignments s JOIN assets a ON a.id = s.asset_id
WHERE a.asset_code LIKE 'IAC-IT-%' AND NOT EXISTS (SELECT 1 FROM assignment_events e WHERE e.assignment_id = s.id);

-- 7. One "added to the register" entry per asset (at purchase date when known), plus disposals.
INSERT INTO asset_movements(asset_id, kind, reason, actor_id, occurred_at)
SELECT a.id, 'STATUS_CHANGE',
  'Added from the IT asset register' || CASE WHEN a.purchase_date IS NOT NULL THEN ' (purchased ' || to_char(a.purchase_date, 'DD Mon YYYY') || ')' ELSE '' END
    || CASE WHEN r.prev_unmatched IS NOT NULL THEN '. Previous holder(s) not in Zoho: ' || r.prev_unmatched ELSE '' END,
  (SELECT id FROM importer), least(coalesce(a.purchase_date::timestamptz, a.created_at), a.created_at) - interval '1 second'
FROM assets a JOIN reg r ON r.asset_code = a.asset_code;
INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
SELECT a.id, 'STATUS_CHANGE', 'Marked ' || a.status || ' (from the IT asset register)', (SELECT id FROM importer)
FROM assets a WHERE a.asset_code LIKE 'IAC-IT-%' AND a.status IN ('Disposed','Sold');

-- 8. Software licence from the "Software Licenses" sheet.
DO $$ DECLARE next_no int; code text; new_id uuid; BEGIN
  IF NOT EXISTS (SELECT 1 FROM assets WHERE description LIKE 'GStartCAD%') THEN
    SELECT next_value INTO next_no FROM team_asset_counters WHERE team_id = '00000000-0000-4000-8000-000000000001' FOR UPDATE;
    code := 'IAC-IT-' || lpad(next_no::text, 6, '0');
    UPDATE team_asset_counters SET next_value = next_no + 1 WHERE team_id = '00000000-0000-4000-8000-000000000001';
    INSERT INTO assets(asset_code, category, asset_type, description, manufacturer, ownership_type, status, condition,
      risk_level, purchase_date, purchase_cost, department_id, remarks, owning_team_id, finance_status, finance_pending, created_by)
    VALUES (code, 'Software License', 'Design Software', 'GStartCAD Software (3 user licences, perpetual)', 'GStartCAD',
      'Owned', 'Active', 'Unknown', 'Unknown', '2026-04-01', 65844,
      (SELECT id FROM departments WHERE name = 'IT'),
      'Licence LIC-0001 | User subscription, perpetual, 3 seats, all assigned | Users: Animesh Chakraborty, Probhas Das, Tusar Biswas | Technical owner: Shamim Akhtar | Auto renew: No | Compliant',
      '00000000-0000-4000-8000-000000000001', 'APPROVED', false, (SELECT id FROM importer))
    RETURNING id INTO new_id;
    INSERT INTO asset_identifiers(asset_id, kind, value, created_by) VALUES (new_id, 'QR', code, (SELECT id FROM importer));
    INSERT INTO asset_movements(asset_id, kind, reason, actor_id)
    VALUES (new_id, 'STATUS_CHANGE', 'Added from the Software Licenses sheet of the IT asset register', (SELECT id FROM importer));
  END IF;
END $$;

INSERT INTO audit_events(actor_kind, request_id, actor_id, entity_type, entity_id, action, changes)
SELECT 'USER', gen_random_uuid(), (SELECT id FROM importer), 'asset', NULL, 'IT_REGISTER_UPDATED',
  jsonb_build_object('located', (SELECT count(*) FROM assets WHERE asset_code LIKE 'IAC-IT-%' AND location_id IS NOT NULL),
                     'held', (SELECT count(*) FROM assignments s JOIN assets a ON a.id=s.asset_id WHERE s.ended_at IS NULL AND a.asset_code LIKE 'IAC-IT-%'),
                     'previousHolders', (SELECT count(*) FROM assignments s JOIN assets a ON a.id=s.asset_id WHERE s.ended_at IS NOT NULL AND a.asset_code LIKE 'IAC-IT-%'));

SELECT 'assets' AS item, count(*)::text AS n FROM assets WHERE asset_code LIKE 'IAC-IT-%'
UNION ALL SELECT 'with location', count(*)::text FROM assets WHERE asset_code LIKE 'IAC-IT-%' AND location_id IS NOT NULL
UNION ALL SELECT 'held now', count(*)::text FROM assignments s JOIN assets a ON a.id=s.asset_id WHERE s.ended_at IS NULL AND a.asset_code LIKE 'IAC-IT-%'
UNION ALL SELECT 'previous holders', count(*)::text FROM assignments s JOIN assets a ON a.id=s.asset_id WHERE s.ended_at IS NOT NULL AND a.asset_code LIKE 'IAC-IT-%'
UNION ALL SELECT 'history entries', count(*)::text FROM asset_movements m JOIN assets a ON a.id=m.asset_id WHERE a.asset_code LIKE 'IAC-IT-%'
UNION ALL SELECT 'emails queued', count(*)::text FROM email_deliveries WHERE state IN ('PENDING','LEASED');
COMMIT;
