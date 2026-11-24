-- Vendor import for the IAC Asset Management System.
-- Run after migrations 059_vendors.sql and 060_vendor_name_key.sql. Safe to re-run: existing vendors are updated by name.
-- Staff names are linked only when users.display_name matches (case-insensitive).
BEGIN;

CREATE TEMP TABLE vendor_import (
  name text NOT NULL,
  services text,
  contact_person text,
  phone text,
  email text,
  address text,
  score numeric(3,1),
  reference_names text[],
  notes text
) ON COMMIT DROP;

INSERT INTO vendor_import(name, services, contact_person, phone, email, address, score, reference_names, notes) VALUES
('Comp - Tech Sales & Services','All IT and Others Services','Ghansham','9830942000',NULL,'138, Canning Street Kolkata 700001',7.5,ARRAY['Shamim'],NULL),
('Optima Infotech','All IT and Others Services','Anil Bader','9830040965',NULL,'24, Park Street, Park Center Market Ground Floor kolkata 16',10,ARRAY['Shamim'],NULL),
('Cartridge Hub','Printer Catridege','Pranab','9830222925',NULL,'124/1B, Raja Dinendra Street Kolkata 700004',7,ARRAY['Shamim','Janice'],NULL),
('Spear Networks Pvt Ltd','Networking / Networking Related Issues','Vineet Bhojnagarwala','9831436607',NULL,'HA-245, Sector -3, Salt Lake City Kolkata 700097',10,ARRAY['Nishant','Shamim'],NULL),
('CRM Enterprise Business Pvt Ltd','CCTV','Dipayan Manji','9614976807',NULL,'Chandni',8,ARRAY['Mukut','Shamim'],NULL),
('Rebin Infotech','Fixed Asset Managerment and Customize Solutions','Nitesh Kumar','8100241304',NULL,'139, Dum Dum Park Kolkata 700055',7,ARRAY['Shamim'],NULL),
('Asset Thread','Fixed Asset Managerment and Customize Solutions','Ajayraj Jaiswar','9167836822',NULL,'904, & 906, Corporate Annexe Sonawala Road, Goregaon (East) Mumbai 400063',7.5,ARRAY['Shamim'],NULL),
('HRM Thread','Comprehensive Payroll & HR Software','Priya Jaiswal','9833112764',NULL,'904, & 906, Corporate Annexe Sonawala Road, Goregaon (East) Mumbai 400063',NULL,ARRAY['Shamim'],NULL),
('SuperinfoLab Pvt Ltd','Comprehensive Payroll & HR Software','Brijesh Kumar Rai','9163300952',NULL,'4th Floor, 59B, Chowringhee Road Kolkata 70020',NULL,ARRAY['Shamim'],NULL),
('Cognitech IT Consultancy','All IT and Others Services','Abhijit Kumar','9073366733',NULL,'5/14 Poddar Nagar, Kadavpur Kolkata 700068',8,ARRAY['Shamim'],NULL),
('Creative Room','Printing and Designing','Abhijit Kumar','9674386191',NULL,'3/7/3, Kalachand Nandy Lane Howrah 711101',8,ARRAY['Shamim'],NULL),
('Siemtel Telenetwork Pvt Ltd','All VC and Communication','Vishal Singh','9830046996',NULL,'4, Lee Road Kolkata 700020',7.5,ARRAY['Nishant','Shamim'],NULL),
('Airtel Mobile & Internet','Internet & Mobile Connection','Saiwasuri','9311362245',NULL,'Salt Lake',9,ARRAY['Shamim'],NULL),
('Jio Mobile & Internet','Internet & Mobile Connection','Suman','9163668640',NULL,'Bhawanipur',9,ARRAY['Shamim'],NULL),
('Vodafone Mobile & Internet','Internet & Mobile Connection','Shuvadip Das','8585859967',NULL,'Salt Lake',9,ARRAY['Shamim'],NULL),
('Jio IoT Device & GPS','IoT Device and GPS Provider','Suhel','7003000700',NULL,'Salt Lake',7,ARRAY['Shamim'],NULL),
('Spine HRMS Pvt Ltd','Comprehensive Payroll & HR Software','Kishan Joshi','9324470890',NULL,'Bangalore',8,ARRAY['Shamim'],NULL),
('Ankur Telecom','All VC and Communication','Nikhil','9836000063',NULL,'10, Buckimgham Court, 113-B Ripon Street Kolkata 700016',10,ARRAY['Shamim'],NULL),
('MElimu Edutech Private Limited','LMS','Nancy','7310608429',NULL,'A-89, Sector -63, Noida Gautam Buddha Nagar, Uttar Pradesh 201301',10,ARRAY['Shamim'],NULL),
('Cloud Centric Infotech Pvt Ltd','Salesforce','Ritesh Kesarwani','9810014624',NULL,'H-146 & 147, Ground Floor, Noida Gautam Buddha Nagar, Uttar Pradesh 201301',10,ARRAY['Shamim'],NULL),
('Eagle Techsec Communications India Pvt. Ltd','ELV And Networking','Mr. Soumyadeep Maity','7838949924','soumyadeep.maity@etcipl.com',NULL,NULL,ARRAY['Shamim'],'First Time Engage'),
('Spycom India Pvt. Ltd.','ELV And Networking','Ms. Tanya Sharma / Mr. Sachin Sharma','93011 03227', 'tanya.sharma@spycomindia.in; spycomindia101@gmail.com; sachin.sharma@spycomindia.in',NULL,NULL,ARRAY['Shamim'],'First Time Engage'),
('Pillar 9 TAE India Pvt. Ltd.','ELV And Networking','Mr. Himanshu Thakur','9930156239','himanshu@pi9.in',NULL,NULL,ARRAY['Shamim'],'First Time Engage'),
('Shree E solutions','ELV And Networking','Mr. Govind daga','9330115901 / 9831015901','shreesolutions07@gmail.com',NULL,NULL,ARRAY['Shamim'],'First Time Engage'),
('BlackBox','ELV And Networking','Mr. Yadhuvinder singh','9051744475','vadvinder.singh@blackbox.com',NULL,NULL,ARRAY['Shamim'],'First Time Engage'),
('Velocis system pvt.Ltd','ELV And Networking','Mr.Sucharita','8017386085','sucharita.mandal@velocis.in',NULL,NULL,ARRAY['Shamim'],'First Time Engage');

-- Import company/contact fields. Unprovided website, GSTIN, and address values remain NULL.
INSERT INTO vendors(name, services, contact_person, phone, email, address, score, notes)
SELECT name, services, contact_person, phone, email, address, score, notes
FROM vendor_import
ON CONFLICT (vendor_key(name)) DO UPDATE SET
  services = EXCLUDED.services,
  contact_person = EXCLUDED.contact_person,
  phone = EXCLUDED.phone,
  email = EXCLUDED.email,
  address = EXCLUDED.address,
  score = EXCLUDED.score,
  notes = EXCLUDED.notes,
  updated_at = now(),
  version = vendors.version + 1;

-- Link reference people. The sheet uses first names ("Shamim"), so a name links when it is a
-- staff member's full name, or the first name of exactly one current staff member (never
-- someone who has left). Ambiguous or unknown names are listed below and not linked.
CREATE TEMP TABLE vendor_reference_match ON COMMIT DROP AS
SELECT ref_name, (array_agg(u.id))[1] AS user_id, count(u.id) AS matches
FROM (SELECT DISTINCT unnest(reference_names) AS ref_name FROM vendor_import) r
LEFT JOIN users u
  ON u.left_at IS NULL
 AND u.state IN ('ACTIVE','INVITED','DIRECTORY')
 AND u.merged_into_user_id IS NULL
 AND (lower(btrim(u.display_name)) = lower(btrim(r.ref_name))
      OR lower(split_part(btrim(u.display_name), ' ', 1)) = lower(btrim(r.ref_name)))
GROUP BY ref_name;

INSERT INTO vendor_reference_people(vendor_id, user_id)
SELECT DISTINCT v.id, m.user_id
FROM vendor_import i
JOIN vendors v ON vendor_key(v.name) = vendor_key(i.name)
CROSS JOIN LATERAL unnest(i.reference_names) AS r(person)
JOIN vendor_reference_match m ON m.ref_name = r.person AND m.matches = 1
ON CONFLICT DO NOTHING;

-- Names not linked: "not found" (no current staff member) or "more than one" (ambiguous).
SELECT ref_name AS reference_person,
       CASE WHEN matches = 0 THEN 'not found' ELSE 'more than one staff member' END AS not_linked_because,
       string_agg(DISTINCT i.name, ', ') AS vendors
FROM vendor_reference_match m
JOIN vendor_import i ON m.ref_name = ANY(i.reference_names)
WHERE m.matches <> 1
GROUP BY ref_name, matches
ORDER BY ref_name;

COMMIT;
