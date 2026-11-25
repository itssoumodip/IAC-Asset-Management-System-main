"""Builds far-2026-27-import.sql from the finance fixed asset register (FAR) workbook.

Usage:  python -I "import sql/generate-far-import.py" "<path to Fixed asset 26-27.xlsx>"

Reads the CONSOLIDATED sheet (every register row, with 2025-26 figures and the 2026-27
additions). Writes the SQL next to this script plus far-2026-27-review.csv listing rows that
need a finance check. Run the SQL with psql; it refuses to run twice.

What the SQL does (decided with the asset owner):
- every row becomes one asset (a batch row stays one asset; its quantity goes in the description);
- rows that are IT assets already in the software (same serial, or same bill and cost) are not
  duplicated: blank finance fields are filled in and the register's depreciation is attached;
- depreciation continues from the register: the 2025-26 figures (WDV at 31-3-2026) are stored as
  each asset's 2025 schedule, and each row keeps its own WDV rate; land and other rate-0 rows get
  "No depreciation".
"""
import csv, datetime, json, os, re, sys
from collections import Counter, defaultdict

import openpyxl

TAG = '2026-27'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_SQL = os.path.join(HERE, 'far-2026-27-import.sql')
OUT_CSV = os.path.join(HERE, 'far-2026-27-review.csv')
FY_START = datetime.date(2025, 4, 1)   # the register's last closed year: 2025-26
FY_END = datetime.date(2026, 3, 31)

IT, ADM, PRJ = 'IT', 'ADM', 'PRJ'

# --------------------------------------------------------------------------------------------
# Reading

def text(v):
    if v is None or isinstance(v, (datetime.time,)): return None
    if isinstance(v, float) and v.is_integer(): v = int(v)
    s = ' '.join(str(v).split())
    return None if s in ('', '0', '-', 'NA', 'N/A', 'None', '#VALUE!', '#REF!', '#N/A') else s

def num(v):
    if v is None or isinstance(v, bool): return None
    try: return float(v)
    except (TypeError, ValueError): return None

def day(v):
    if isinstance(v, datetime.datetime): v = v.date()
    if isinstance(v, datetime.date):
        return v if v.year >= 1990 else None
    return None

def load(path):
    ws = openpyxl.load_workbook(path, data_only=True, read_only=True)['CONSOLIDATED']
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    hi = next(i for i, r in enumerate(rows) if 'Particulars' in r)
    head = [re.sub(r'[^a-z0-9]', '', str(h or '').lower()) for h in rows[hi]]
    def col(name, after=-1):
        return next(i for i, h in enumerate(head) if h == name and i > after)
    c = {
        'barcode': col('barcodingyn'), 'name': col('particulars'), 'group': col('grouping'),
        'sub': col('subgroup'), 'location': col('location'), 'life': col('estimatedlifeinyrs'),
        'cost': col('purchasevalue'), 'scrap': col('scrapvalue'), 'custodian': col('usercustodian'),
        'model': col('model'), 'qty': col('qty'), 'serial': col('serialno'), 'dop': col('dop'),
        'docap': col('docap'), 'bill': col('billno'), 'party': col('party'),
        'days': col('noofdaysofdepforcurrentfy'),
        'rate': col('wdvrateofdep'), 'acc25': col('accumulateddep3132025'),
        'pur2526': next(i for i, h in enumerate(head) if h.startswith('purchasesduringtheyear') and h.endswith('2526')),
        'dep2526': col('depreciation2526'), 'wdv26': col('wdvofasset3132026'),
        'gross26': col('grossblock3132026'), 'acc26': col('accumulateddep3132026'),
    }
    c['disp2526'] = col('disposal', c['dep2526'])
    out = []
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        r = r + [None] * 40
        cost = num(r[c['cost']])
        name = text(r[c['name']])
        if not name or not cost or cost <= 0: continue
        out.append({
            'row': n, 'name': name, 'group': text(r[c['group']]), 'sub': text(r[c['sub']]),
            'location': text(r[c['location']]), 'life': num(r[c['life']]), 'cost': round(cost, 2),
            'scrap': num(r[c['scrap']]), 'custodian': text(r[c['custodian']]),
            'model': text(r[c['model']]), 'qty': num(r[c['qty']]), 'serial': text(r[c['serial']]),
            'dop': day(r[c['dop']]), 'docap': day(r[c['docap']]), 'bill': text(r[c['bill']]),
            'party': text(r[c['party']]), 'rate': num(r[c['rate']]), 'days': num(r[c['days']]),
            'acc25': num(r[c['acc25']]), 'pur2526': num(r[c['pur2526']]),
            'dep2526': num(r[c['dep2526']]), 'disp2526': num(r[c['disp2526']]),
            'wdv26': num(r[c['wdv26']]), 'gross26': num(r[c['gross26']]), 'acc26': num(r[c['acc26']]),
            'barcoded': text(r[c['barcode']]) == 'Y',
        })
    return out

# --------------------------------------------------------------------------------------------
# Mapping: register group / name → software category, subcategory and owning team

NEW_CATEGORIES = {'Land & Building': ADM}
# New subcategories: code → (category, needs a custodian?)
NEW_TYPES = {
    'Business Software': ('Software License', False), 'Website': ('Software License', False),
    'IT Accessory': ('IT Hardware', False), 'Course Content': ('Educational & Learning Materials', False),
    'Training & Research Kit': ('Educational & Learning Materials', False),
    'Camera & Studio Equipment': ('Audio Visual', False), 'General Office Equipment': ('Office Equipment', False),
    'Fire Extinguisher': ('Other', False), 'Stabilizer': ('Electrical Equipment', False),
    'Electrical Installation': ('Electrical Equipment', False), 'Signage': ('Furniture', False),
    'Sanitary & Plumbing': ('Furniture', False), 'Interiors & Fixtures': ('Furniture', False),
    'Furniture Set': ('Furniture', False), 'Dustbin': ('Housekeeping & Cleaning', False),
    'Tools & Equipment': ('Heavy Machinery', False), 'Tractor & Trolley': ('Heavy Machinery', False),
    'Bicycle': ('Vehicle', False), 'Boat': ('Vehicle', False),
    'Land': ('Land & Building', False), 'Building': ('Land & Building', False),
    'Land Development': ('Land & Building', False), 'Temporary Structure': ('Land & Building', False),
    'Borewell': ('Land & Building', False), 'Live Stock': ('Other', False),
    'Valuables': ('Other', False), 'Planters': ('Outdoor', False),
}
# Who owns each category's assets here (must be one of the category's teams in the software).
CATEGORY_TEAM = {
    'IT Hardware': IT, 'Software License': IT, 'Audio Visual': IT, 'Security & ELV': IT,
    'Office Equipment': ADM, 'Educational & Learning Materials': PRJ, 'Furniture': ADM,
    'Electrical Equipment': ADM, 'Kitchen Equipment': ADM, 'Housekeeping & Cleaning': ADM,
    'Heavy Machinery': ADM, 'Vehicle': ADM, 'Outdoor': ADM, 'Other': ADM,
    'Medical & First Aid': ADM, 'Land & Building': ADM,
}

def has(t, *words):
    return any(w in t for w in words)

def classify(r):
    g = r['group'] or ''
    # Item name and sub group only: the group name itself ("Computer & Softwares") would match rules.
    t = ' '.join(filter(None, [r['name'], r['sub']])).lower()
    word = lambda w: re.search(rf'\b{w}\b', t) is not None
    if g == 'Computer & Softwares':
        if has(t, 'printer'): return 'Office Equipment', 'Printer', IT
        if has(t, 'scanner'): return 'Office Equipment', 'Scanner', IT
        if word('ups'): return 'IT Hardware', 'UPS', IT
        if has(t, 'i pad', 'ipad'): return 'IT Hardware', 'Tablet', IT
        if has(t, 'hard disk', 'hdd', 'sandisk', 'seagate'): return 'IT Hardware', 'External Storage', IT
        if has(t, 'video conferenc'): return 'Audio Visual', 'Video Conferencing Device', IT
        if has(t, 'adobe'): return 'Software License', 'Design Software', IT
        if has(t, 'crm', 'lms', 'software'): return 'Software License', 'Business Software', IT
        if word('cover') or word('case') or has(t, 'tempered', 'glass'): return 'IT Hardware', 'IT Accessory', IT
        if has(t, 'desktop', 'imac', 'nuc', 'eye tracker'): return 'IT Hardware', 'Desktop', IT
        return 'IT Hardware', 'Laptop', IT
    if g == 'Intangible Assets':
        if has(t, 'course'): return 'Educational & Learning Materials', 'Course Content', PRJ
        return 'Software License', 'Website', IT
    if g.lower().startswith('books'): return 'Educational & Learning Materials', 'Library Books', PRJ
    if g == 'Land': return 'Land & Building', 'Land', ADM
    if g == 'Building':
        if has(t, 'land development'): return 'Land & Building', 'Land Development', ADM
        return 'Land & Building', 'Building', ADM
    if g == 'Temporary Building': return 'Land & Building', 'Temporary Structure', ADM
    if g == 'Borewell': return 'Land & Building', 'Borewell', ADM
    if g == 'Live Stock': return 'Other', 'Live Stock', ADM
    if g == 'Electrical Installation':
        if has(t, 'bulb'): return 'Electrical Equipment', 'Light', ADM
        return 'Electrical Equipment', 'Electrical Installation', ADM
    if g == 'Plant & Machinery':
        if has(t, 'pump'): return 'Heavy Machinery', 'Water Pump', ADM
        if has(t, 'grass', 'mow'): return 'Heavy Machinery', 'Lawn Mower', ADM
        if has(t, 'tractor', 'trolley'): return 'Heavy Machinery', 'Tractor & Trolley', ADM
        if has(t, 'sprinkler'): return 'Outdoor', 'Garden Tool', ADM
        return 'Heavy Machinery', 'Tools & Equipment', ADM
    if g == 'Motor Vehicle':
        if has(t, 'bicycle'): return 'Vehicle', 'Bicycle', ADM
        if has(t, 'kayak', 'boat'): return 'Vehicle', 'Boat', ADM
        if has(t, 'tata ace'): return 'Vehicle', 'Van', ADM
        if has(t, 'bike', 'tvs', 'bajaj', 'sp125', 'raider', 'scooty', 'activa'): return 'Vehicle', 'Two-wheeler', ADM
        return 'Vehicle', 'Car', ADM
    if g == 'Furniture & Fixture':
        if has(t, 'floor cleaner'): return 'Housekeeping & Cleaning', 'Floor Scrubber', ADM
        if has(t, 'crockery', 'crokery'): return 'Kitchen Equipment', 'Cookware', ADM
        if has(t, 'dustbin'): return 'Housekeeping & Cleaning', 'Dustbin', ADM
        if has(t, 'fan'): return 'Electrical Equipment', 'Fan', ADM
        if has(t, 'signage'): return 'Furniture', 'Signage', ADM
        if has(t, 'sanitary', 'plumbing'): return 'Furniture', 'Sanitary & Plumbing', ADM
        if has(t, 'book shelf', 'bookshelf'): return 'Furniture', 'Bookshelf', ADM
        if has(t, 'almirah', 'shelves', 'shoe rack'): return 'Furniture', 'Cabinet', ADM
        if has(t, 'bed', 'cot', 'mattress'): return 'Furniture', 'Bed', ADM
        if has(t, 'chair'): return 'Furniture', 'Chair', ADM
        if has(t, 'table', 'podium'): return 'Furniture', 'Table', ADM
        if has(t, 'interior', 'civil', 'fitting', 'godown', 'fabric', 'wooden material', 'cwip'):
            return 'Furniture', 'Interiors & Fixtures', ADM
        return 'Furniture', 'Furniture Set', ADM
    # Office Equipment and anything without a group.
    if has(t, 'planter'): return 'Outdoor', 'Planters', ADM
    if has(t, 'silver'): return 'Other', 'Valuables', ADM
    if has(t, 'mixer grinder', 'mixer ginder'): return 'Kitchen Equipment', 'Kitchen', ADM
    if has(t, 'air condition'): return 'Electrical Equipment', 'Air Conditioner', ADM
    if has(t, 'cctv'): return 'Security & ELV', 'CCTV Camera', IT
    if has(t, 'biometric'): return 'Security & ELV', 'Biometric Device', IT
    if has(t, 'card reader'): return 'Security & ELV', 'Access Control', IT
    if has(t, 'router', 'network', 'netrack', 'pdu'): return 'Security & ELV', 'Networking', IT
    if has(t, 'docking'): return 'IT Hardware', 'Docking Station', IT
    if has(t, 'mobile'): return 'IT Hardware', 'Mobile Phone', IT
    if has(t, 'handset'): return 'Office Equipment', 'Telephone', ADM
    if has(t, 'video conferenc', 'videos conferenc', 'video conference'): return 'Audio Visual', 'Video Conferencing Device', IT
    if has(t, 'projector'): return 'Audio Visual', 'Projector', IT
    if has(t, 'led tv') or word('tv'): return 'Audio Visual', 'Television', IT
    if has(t, 'mic', 'sennheiser', 'headphone'): return 'Audio Visual', 'Microphone', IT
    if has(t, 'speaker', 'audio system', 'mixer'): return 'Audio Visual', 'Speaker', IT
    if has(t, 'camera', 'sony', 'lens', 'tripod', 'godox', 'video light', 'battery', 'charger', 'duracell', 'wm8'):
        return 'Audio Visual', 'Camera & Studio Equipment', IT
    if has(t, 'shredder'): return 'Office Equipment', 'Shredder', ADM
    if has(t, 'refrig'): return 'Kitchen Equipment', 'Refrigerator', ADM
    if has(t, 'microwave'): return 'Kitchen Equipment', 'Microwave', ADM
    if has(t, 'kent', 'purifier', 'iron remover', 'filter', 'water cooler'): return 'Kitchen Equipment', 'Water Purifier', ADM
    if has(t, 'induction', 'cook top', 'cooktop'): return 'Kitchen Equipment', 'Induction Cooktop', ADM
    if has(t, 'kitchen', 'utensil', 'kettle', 'grill', 'chaffing', 'tiffin', 'bowl', 'knife', 'coffee', 'tea ', 'quadro', 'crockery'):
        return 'Kitchen Equipment', 'Kitchen', ADM
    if has(t, 'washing machine'): return 'Housekeeping & Cleaning', 'Washing Machine', ADM
    if has(t, 'fire extinguisher'): return 'Other', 'Fire Extinguisher', ADM
    if has(t, 'geyser'): return 'Electrical Equipment', 'Water Heater', ADM
    if has(t, 'electrical installation'): return 'Electrical Equipment', 'Electrical Installation', ADM
    if has(t, 'exhaust', 'fan'): return 'Electrical Equipment', 'Fan', ADM
    if has(t, 'led light', 'lights'): return 'Electrical Equipment', 'Light', ADM
    if has(t, 'inverter'): return 'Electrical Equipment', 'Inverter', ADM
    if has(t, 'stabilizer', 'v guard'): return 'Electrical Equipment', 'Stabilizer', ADM
    if has(t, 'shoe rack'): return 'Furniture', 'Cabinet', ADM
    if has(t, 'weighing'): return 'Medical & First Aid', 'Weighing Scale', ADM
    if has(t, 'training', 'tower of london', 'tlm', 'clay', 'universal foot'):
        return 'Educational & Learning Materials', 'Training & Research Kit', PRJ
    return 'Office Equipment', 'General Office Equipment', ADM

# Register location → software location code. New ones are created by the SQL.
NEW_LOCATIONS = [  # (code, name, level, parent code)
    ('IAC-SITE-OFFICE', 'Site Office', 'BUILDING', 'IAC-SITE'),
    ('IAC-SITE-TA', 'Training Academy', 'BUILDING', 'IAC-SITE'),
    ('IAC-SITE-SB', 'Security Block & Guard House', 'BUILDING', 'IAC-SITE'),
    ('IAC-SITE-CANTEEN', 'Canteen & Store', 'BUILDING', 'IAC-SITE'),
    ('IAC-SITE-PORTA', 'Porta Cabin', 'BUILDING', 'IAC-SITE'),
    ('IAC-SITE-CC', 'Community Center', 'BUILDING', 'IAC-SITE'),
    ('IAC-AMTALLA', 'Amtalla Guest House', 'SITE', None),
]
BASE_LOCATIONS = [
    ('IAC-HO', 'Head Office (HO)', 'SITE', None), ('IAC-HO-GF', 'Ground Floor', 'FLOOR', 'IAC-HO'),
    ('IAC-HO-2F', '2nd Floor', 'FLOOR', 'IAC-HO'), ('IAC-HO-3F', '3rd Floor', 'FLOOR', 'IAC-HO'),
    ('IAC-SITE', 'Project Site', 'SITE', None),
]

def location(r):
    loc = (r['location'] or '').lower()
    hint = ' '.join(filter(None, [r['location'], r['name'], r['sub'], r['custodian']])).lower()
    for words, code in (
        (('amtal',), 'IAC-AMTALLA'), (('fmc 3rd', '3rd floor'), 'IAC-HO-3F'), (('fmc 2nd', '2nd floor'), 'IAC-HO-2F'),
        (('ground floor',), 'IAC-HO-GF'), (('porta',), 'IAC-SITE-PORTA'), (('canteen',), 'IAC-SITE-CANTEEN'),
        (('security block', 'guard house', 'sb+gh'), 'IAC-SITE-SB'), (('training academy',), 'IAC-SITE-TA'),
        (('community cent', 'coomunity'), 'IAC-SITE-CC'), (('site - office', 'site office'), 'IAC-SITE-OFFICE'),
    ):
        if any(w in hint for w in words): return code
    if loc.startswith('site') or (r['custodian'] or '').lower().startswith('site'): return 'IAC-SITE'
    return 'IAC-HO'

# Each row keeps its own register rate; rows without one take their group's usual rate.
GROUP_RATE = {
    'Computer & Softwares': 0.6316, 'Office Equipment': 0.4507, 'Furniture & Fixture': 0.2589,
    'Electrical Installation': 0.2589, 'Plant & Machinery': 0.4507, 'Motor Vehicle': 0.3123,
    'Temporary Building': 0.6316, 'Borewell': 0.4507, 'Building': 0.095,
}

def method(rate):
    if not rate: return 'NO_DEPRECIATION', None
    pct = round(rate * 100, 2)
    return 'WDV_' + f'{pct:.2f}'.replace('.', '_'), pct

# --------------------------------------------------------------------------------------------

def tokens(r):
    found = set()
    for v in (r['model'], r['serial']):
        if not v: continue
        whole = re.sub(r'[^a-z0-9]', '', v.lower())
        if len(whole) >= 6 and re.search(r'\d', whole): found.add(whole)
        for part in re.split(r'[\s/,;]+', v.lower()):
            p = re.sub(r'[^a-z0-9]', '', part)
            if len(p) >= 6 and re.search(r'\d', p) and re.search(r'[a-z]', p): found.add(p)
    return sorted(found)

def q(v):
    if v is None: return 'NULL'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)): return repr(round(v, 2)) if isinstance(v, float) else str(v)
    if isinstance(v, datetime.date): return f"DATE '{v.isoformat()}'"
    if isinstance(v, (list, tuple)):
        return "ARRAY[" + ','.join(q(x) for x in v) + "]::text[]" if v else "ARRAY[]::text[]"
    return "'" + str(v).replace("'", "''") + "'"

def build(rows):
    review = []
    out = []
    for r in rows:
        cat, typ, team = classify(r)
        rate = r['rate']
        flags = []
        if rate is None:
            rate = GROUP_RATE.get(r['group'] or '', 0)
            flags.append(f"no rate in register; used {round(rate * 100, 2)}%" if rate else 'no rate in register; not depreciated')
        code, pct = method(rate)
        in_service = r['docap'] or r['dop']
        # The books carry the gross block at 31-3-2026 (purchase value plus later additions to the
        # same asset); use it as the asset's cost when the register has it.
        cost = r['cost']
        if r['gross26'] and r['gross26'] > 0 and abs(r['gross26'] - r['cost']) > 1:
            cost = round(r['gross26'], 2)
            flags.append(f"gross block {r['gross26']:.2f} differs from purchase value {r['cost']:.2f}; used the gross block")
        # 2025-26 schedule: from the register's figures, or worked out with its formula.
        sched = None
        if in_service is None:
            flags.append('no purchase or capitalisation date')
        elif in_service <= FY_END and pct:
            if r['wdv26'] is not None and r['wdv26'] >= 0 and (r['dep2526'] is not None or r['acc26'] is not None):
                charge = r['dep2526'] or 0
                closing = r['wdv26']
                opening = closing + charge
                if in_service < FY_START and abs(cost - (r['acc25'] or 0) - opening) > 1:
                    flags.append(f"register figures do not add up (cost {cost:.0f} − dep to 31-3-2025 {r['acc25'] or 0:.0f} ≠ WDV + 2025-26 dep {opening:.0f}); used the register WDV")
            else:
                opening = cost - (r['acc25'] or 0) if in_service < FY_START else cost
                days = 365 if in_service < FY_START else (FY_END - in_service).days + 1
                charge = round(opening * rate * days / 365)
                closing = opening - charge
                flags.append(f'2025-26 not filled in the register; worked out {charge:.0f} with its formula')
            acc = cost - closing
            sched = (round(opening, 2), round(charge, 2), round(closing, 2), round(acc, 2))
        if r['disp2526']: flags.append(f"register shows a disposal of {r['disp2526']:.0f} in 2025-26; check status")
        # The register's 2026-27 formula uses the typed "days" column; an asset in use before
        # 1 April 2026 should count the full year.
        if in_service and in_service <= FY_END and pct and r['days'] and r['days'] != 365:
            flags.append(f"register uses {r['days']:.0f} days for 2026-27 although the asset was in use all year; the software will charge the full year")
        qty = int(r['qty']) if r['qty'] and r['qty'] > 1 else None
        desc = r['name'] + (f' (qty {qty})' if qty else '')
        life = int(r['life']) if r['life'] and r['life'] > 0 and float(r['life']).is_integer() else None
        scrap = round(r['scrap'], 2) if r['scrap'] and 0 < r['scrap'] <= cost else None
        meta = {k: v for k, v in {
            'source': f'Fixed asset register {TAG}', 'row': r['row'], 'group': r['group'],
            'subGroup': r['sub'], 'location': r['location'], 'custodian': r['custodian'],
            'quantity': r['qty'] if r['qty'] else None, 'barcoded': r['barcoded'] or None,
            'wdvRate': r['rate'], 'purchaseValue': r['cost'] if cost != r['cost'] else None,
        }.items() if v is not None}
        remarks = f"Fixed asset register {TAG}, CONSOLIDATED row {r['row']}."
        if r['custodian']: remarks += f" Register custodian: {r['custodian']}."
        out.append({
            'ord': r['row'], 'team': team, 'category': cat, 'type': typ, 'description': desc[:500],
            'model': r['model'], 'serial': r['serial'], 'location': location(r),
            'cost': cost, 'scrap': scrap, 'life': life, 'dop': r['dop'] or r['docap'],
            'docap': in_service, 'bill': r['bill'], 'party': r['party'], 'method': code, 'pct': pct,
            'tokens': tokens(r) if team == IT else [], 'meta': json.dumps(meta, ensure_ascii=False),
            'remarks': remarks, 'sched': sched,
        })
        if flags:
            review.append({'row': r['row'], 'name': r['name'], 'group': r['group'], 'cost': r['cost'],
                           'note': '; '.join(flags)})
    return out, review

def write_sql(items, rows):
    methods = sorted({(i['method'], i['pct']) for i in items if i['pct']})
    types = sorted({(i['type'], i['category']) for i in items})
    for t in types:
        if t[0] not in NEW_TYPES and t[1] not in CATEGORY_TEAM:
            raise SystemExit(f'unmapped category {t}')
    total = round(sum(i['cost'] for i in items), 2)
    L = []
    w = L.append
    w(f'-- Fixed asset register {TAG}: import into the asset software. Generated by generate-far-import.py; safe to read.')
    w(f'-- {len(items)} register rows, purchase value {total:,.2f}. Sends NO notifications. Refuses to run twice.')
    w('-- Existing IT assets with the same serial (or same bill and cost) are not duplicated: blank finance')
    w('-- fields are filled in. Depreciation continues from the register: 2025-26 is stored as the 2025 schedule.')
    w('\\set ON_ERROR_STOP on')
    w('BEGIN;')
    w('DO $$ BEGIN')
    w(f"  IF EXISTS (SELECT 1 FROM audit_events WHERE action = 'FAR_IMPORTED' AND changes->>'tag' = '{TAG}') THEN")
    w(f"    RAISE EXCEPTION 'The fixed asset register {TAG} was already imported.';")
    w('  END IF;')
    w("  IF NOT EXISTS (SELECT 1 FROM depreciation_method_rules WHERE method_code = 'NO_DEPRECIATION') THEN")
    w("    RAISE EXCEPTION 'Deploy the latest version first (migration 063_depreciation_none.sql is missing).';")
    w('  END IF;')
    w('END $$;')
    w("CREATE TEMP TABLE importer ON COMMIT DROP AS")
    w("  SELECT ur.user_id AS id FROM user_roles ur WHERE ur.role_code='SUPER_ADMIN' ORDER BY ur.granted_at LIMIT 1;")
    w("CREATE TEMP TABLE team_ids ON COMMIT DROP AS SELECT code, id FROM teams WHERE code IN ('IT','ADM','PRJ');")
    w('')
    w('-- Categories, subcategories, locations and depreciation methods (existing ones are kept).')
    for cat, team in NEW_CATEGORIES.items():
        w(f"INSERT INTO reference_values(kind, code, label) VALUES ('CATEGORY', {q(cat)}, {q(cat)}) ON CONFLICT (kind, code) DO NOTHING;")
        w(f"INSERT INTO category_policies(category_code, handling_team_id) SELECT {q(cat)}, id FROM team_ids WHERE code = {q(team)} ON CONFLICT (category_code) DO NOTHING;")
    # Every category used must list the owning team among its teams.
    pairs = sorted({(i['category'], i['team']) for i in items})
    w('INSERT INTO category_teams(category_code, team_id) SELECT v.cat, t.id FROM (VALUES')
    w(',\n'.join(f'  ({q(c)}, {q(t)})' for c, t in pairs))
    w(') v(cat, team) JOIN team_ids t ON t.code = v.team JOIN category_policies p ON p.category_code = v.cat ON CONFLICT DO NOTHING;')
    new_types = [(code, NEW_TYPES[code]) for code, _ in types if code in NEW_TYPES]
    w('INSERT INTO reference_values(kind, code, label) VALUES')
    w(',\n'.join(f"  ('ASSET_TYPE', {q(code)}, {q(code)})" for code, _ in new_types))
    w('ON CONFLICT (kind, code) DO NOTHING;')
    w('INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code, owning_team_id, handling_team_id)')
    w('SELECT v.code, v.personal, v.cat, p.handling_team_id, p.handling_team_id FROM (VALUES')
    w(',\n'.join(f'  ({q(code)}, {q(personal)}, {q(cat)})' for code, (cat, personal) in new_types))
    w(') v(code, personal, cat) JOIN category_policies p ON p.category_code = v.cat ON CONFLICT (asset_type_code) DO NOTHING;')
    w('DO $$ DECLARE s record; BEGIN')
    w('  FOR s IN SELECT * FROM (VALUES')
    locs = BASE_LOCATIONS + NEW_LOCATIONS
    w(',\n'.join(f'    ({n}, {q(c)}, {q(name)}, {q(lv)}, {q(p)})' for n, (c, name, lv, p) in enumerate(locs)))
    w('  ) v(ord, code, name, level, parent) ORDER BY ord LOOP')
    w('    IF NOT EXISTS (SELECT 1 FROM locations WHERE code = s.code) THEN')
    w('      INSERT INTO locations(code, site, name, level, parent_id)')
    w('      VALUES (s.code, s.name, s.name, s.level, (SELECT id FROM locations WHERE code = s.parent));')
    w('    END IF;')
    w('  END LOOP;')
    w('END $$;')
    w('INSERT INTO reference_values(kind, code, label) VALUES')
    w(',\n'.join(f"  ('DEPRECIATION_METHOD', {q(c)}, {q(f'WDV {p:g}% (finance register)')})" for c, p in methods))
    w('ON CONFLICT (kind, code) DO NOTHING;')
    w('INSERT INTO depreciation_method_rules(method_code, calculation_type, rate_percent) VALUES')
    w(',\n'.join(f"  ({q(c)}, 'WDV', {p})" for c, p in methods))
    w('ON CONFLICT (method_code) DO NOTHING;')
    w('')
    w('-- The register rows.')
    w('CREATE TEMP TABLE far (ord int PRIMARY KEY, team text, category text, asset_type text, description text,')
    w('  model text, serial text, location_code text, cost numeric, scrap numeric, life int, dop date, docap date,')
    w('  bill text, party text, method text, tokens text[], meta jsonb, remarks text,')
    w('  s_opening numeric, s_charge numeric, s_closing numeric, s_accumulated numeric, s_rate numeric,')
    w('  match_id uuid, matched_by text, cost_agrees boolean, new_id uuid) ON COMMIT DROP;')
    w('INSERT INTO far (ord, team, category, asset_type, description, model, serial, location_code, cost, scrap, life,')
    w('  dop, docap, bill, party, method, tokens, meta, remarks, s_opening, s_charge, s_closing, s_accumulated, s_rate) VALUES')
    vals = []
    for i in items:
        s = i['sched'] or (None, None, None, None)
        vals.append('  (' + ', '.join([
            q(i['ord']), q(i['team']), q(i['category']), q(i['type']), q(i['description']), q(i['model']),
            q(i['serial']), q(i['location']), q(i['cost']), q(i['scrap']), q(i['life']), q(i['dop']),
            q(i['docap']), q(i['bill']), q(i['party']), q(i['method']), q(i['tokens']),
            q(i['meta']) + '::jsonb', q(i['remarks']), q(s[0]), q(s[1]), q(s[2]), q(s[3]),
            q(i['pct'] if i['sched'] else None),
        ]) + ')')
    w(',\n'.join(vals) + ';')
    w('')
    w('-- Match IT rows to assets already in the software: a unique serial first, then a unique bill + cost.')
    w("CREATE FUNCTION pg_temp.norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]', '', 'g') $f$;")
    w('UPDATE far f SET match_id = m.id, matched_by = \'serial\' FROM (')
    w('  SELECT f2.ord, min(a.id::text)::uuid AS id, count(DISTINCT a.id) AS n FROM far f2')
    w('  JOIN assets a ON a.removed_at IS NULL AND length(pg_temp.norm(a.serial_number)) >= 6')
    w('   AND pg_temp.norm(a.serial_number) = ANY (f2.tokens)')
    w("  WHERE f2.team = 'IT' GROUP BY f2.ord) m WHERE m.ord = f.ord AND m.n = 1;")
    w('UPDATE far f SET match_id = m.id, matched_by = \'bill and cost\' FROM (')
    w('  SELECT f2.ord, min(a.id::text)::uuid AS id, count(DISTINCT a.id) AS n FROM far f2')
    w('  JOIN assets a ON a.removed_at IS NULL AND length(pg_temp.norm(f2.bill)) >= 5')
    w('   AND pg_temp.norm(a.invoice_number) = pg_temp.norm(f2.bill) AND abs(a.purchase_cost - f2.cost) <= 1')
    w("  WHERE f2.team = 'IT' AND f2.match_id IS NULL GROUP BY f2.ord) m WHERE m.ord = f.ord AND m.n = 1;")
    w('-- One register row per existing asset: if two rows point at the same asset, neither is matched.')
    w('UPDATE far f SET match_id = NULL, matched_by = NULL WHERE match_id IN (')
    w('  SELECT match_id FROM far WHERE match_id IS NOT NULL GROUP BY match_id HAVING count(*) > 1);')
    w('UPDATE far f SET cost_agrees = (a.purchase_cost IS NULL OR abs(a.purchase_cost - f.cost) <= 1)')
    w('  FROM assets a WHERE a.id = f.match_id;')
    w('')
    w('-- Matched: fill blank finance fields only; take the register depreciation when the cost agrees.')
    w('UPDATE assets a SET')
    w('  purchase_cost = coalesce(a.purchase_cost, f.cost),')
    w('  purchase_date = coalesce(a.purchase_date, f.dop),')
    w('  capitalisation_date = coalesce(a.capitalisation_date, f.docap),')
    w("  invoice_number = coalesce(nullif(btrim(a.invoice_number), ''), f.bill),")
    w("  supplier = coalesce(nullif(btrim(a.supplier), ''), f.party),")
    w('  residual_value = CASE WHEN a.residual_value IS NULL AND f.scrap <= coalesce(a.purchase_cost, f.cost) THEN f.scrap ELSE a.residual_value END,')
    w('  useful_life_years = coalesce(a.useful_life_years, f.life),')
    w('  depreciation_method = CASE WHEN f.cost_agrees THEN f.method ELSE a.depreciation_method END,')
    w("  legacy_metadata = coalesce(a.legacy_metadata, '{}'::jsonb) || jsonb_build_object('fixedAssetRegister', f.meta),")
    w('  version = a.version + 1, updated_at = now()')
    w('FROM far f WHERE f.match_id = a.id;')
    w('INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)')
    w("SELECT (SELECT id FROM importer), 'USER', 'asset', f.match_id, 'ASSET_UPDATED',")
    w(f"       jsonb_build_object('source', 'Fixed asset register {TAG}', 'row', f.ord, 'matchedBy', f.matched_by,")
    w("                          'note', 'Blank finance fields filled from the fixed asset register'), gen_random_uuid()")
    w('  FROM far f WHERE f.match_id IS NOT NULL;')
    w('')
    w('-- New assets, numbered from each team\'s counter.')
    w("SELECT pg_advisory_xact_lock(hashtextextended('iac-asset-sequence', 0));")
    w('DO $$ DECLARE f record; nxt bigint; prefix text; code text; tid uuid; aid uuid; BEGIN')
    w('  FOR f IN SELECT * FROM far WHERE match_id IS NULL ORDER BY ord LOOP')
    w('    SELECT id INTO tid FROM team_ids WHERE team_ids.code = f.team;')
    w('    SELECT k.next_value, t.asset_code_prefix INTO nxt, prefix FROM team_asset_counters k JOIN teams t ON t.id = k.team_id')
    w('     WHERE k.team_id = tid FOR UPDATE OF k;')
    w("    LOOP code := 'IAC-' || prefix || '-' || lpad(nxt::text, 6, '0');")
    w('      EXIT WHEN NOT EXISTS (SELECT 1 FROM assets WHERE asset_code = code); nxt := nxt + 1; END LOOP;')
    w('    UPDATE team_asset_counters SET next_value = nxt + 1 WHERE team_id = tid;')
    w('    INSERT INTO assets(asset_code, category, asset_type, description, model, serial_number, ownership_type, status,')
    w('      condition, risk_level, owning_team_id, location_id, purchase_date, capitalisation_date, purchase_cost, currency,')
    w('      residual_value, depreciation_method, useful_life_years, finance_pending, finance_status, invoice_number, supplier,')
    w('      remarks, legacy_metadata, created_by)')
    w("    VALUES (code, f.category, f.asset_type, f.description, f.model, f.serial, 'Owned', 'Active', 'Unknown', 'Low', tid,")
    w("      (SELECT id FROM locations WHERE locations.code = f.location_code), f.dop, f.docap, f.cost, 'INR', f.scrap, f.method,")
    w("      f.life, false, 'APPROVED', f.bill, f.party, f.remarks, jsonb_build_object('fixedAssetRegister', f.meta),")
    w('      (SELECT id FROM importer))')
    w('    RETURNING id INTO aid;')
    w('    UPDATE far SET new_id = aid WHERE ord = f.ord;')
    w('    INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)')
    w("    VALUES ((SELECT id FROM importer), 'USER', 'asset', aid, 'ASSET_CREATED',")
    w(f"      jsonb_build_object('source', 'Fixed asset register {TAG}', 'row', f.ord, 'assetCode', code), gen_random_uuid());")
    w('  END LOOP;')
    w('END $$;')
    w('')
    w('-- 2025-26 from the register, so the 2026-27 run continues from the WDV at 31-3-2026.')
    w('INSERT INTO depreciation_schedules(asset_id, financial_year_start, method, rate, purchase_cost, opening_value,')
    w('  depreciation_charge, closing_value, accumulated_depreciation)')
    w("SELECT coalesce(f.new_id, f.match_id), 2025, 'WDV', f.s_rate, f.cost, f.s_opening, f.s_charge, f.s_closing, f.s_accumulated")
    w('  FROM far f WHERE f.s_rate IS NOT NULL AND (f.new_id IS NOT NULL OR f.cost_agrees)')
    w('ON CONFLICT (asset_id, financial_year_start) DO UPDATE SET method = EXCLUDED.method, rate = EXCLUDED.rate,')
    w('  purchase_cost = EXCLUDED.purchase_cost, opening_value = EXCLUDED.opening_value,')
    w('  depreciation_charge = EXCLUDED.depreciation_charge, closing_value = EXCLUDED.closing_value,')
    w('  accumulated_depreciation = EXCLUDED.accumulated_depreciation;')
    w('')
    w('INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)')
    w("SELECT (SELECT id FROM importer), 'USER', 'import', NULL, 'FAR_IMPORTED', jsonb_build_object(")
    w(f"  'tag', '{TAG}', 'rows', (SELECT count(*) FROM far), 'created', (SELECT count(*) FROM far WHERE new_id IS NOT NULL),")
    w("  'matched', (SELECT count(*) FROM far WHERE match_id IS NOT NULL),")
    w("  'schedules', (SELECT count(*) FROM far WHERE s_rate IS NOT NULL AND (new_id IS NOT NULL OR cost_agrees))), gen_random_uuid();")
    w('')
    w('DO $$ DECLARE r record; BEGIN')
    w("  RAISE NOTICE 'Register rows: %, created: %, matched to existing assets: % (by serial %, by bill and cost %)',")
    w('    (SELECT count(*) FROM far), (SELECT count(*) FROM far WHERE new_id IS NOT NULL),')
    w("    (SELECT count(*) FROM far WHERE match_id IS NOT NULL), (SELECT count(*) FROM far WHERE matched_by = 'serial'),")
    w("    (SELECT count(*) FROM far WHERE matched_by = 'bill and cost');")
    w("  RAISE NOTICE 'Purchase value imported: %', (SELECT sum(cost) FROM far);")
    w('  FOR r IN SELECT f.ord, a.asset_code, a.purchase_cost, f.cost FROM far f JOIN assets a ON a.id = f.match_id')
    w('            WHERE NOT f.cost_agrees ORDER BY f.ord LOOP')
    w("    RAISE NOTICE 'Row %: % already has cost % (register %); kept its own depreciation', r.ord, r.asset_code, r.purchase_cost, r.cost;")
    w('  END LOOP;')
    w('  FOR r IN SELECT f.ord, a.asset_code, a.status FROM far f JOIN assets a ON a.id = f.match_id')
    w("            WHERE a.status IN ('Disposed', 'Sold', 'Retired', 'Scrapped') ORDER BY f.ord LOOP")
    w("    RAISE NOTICE 'Row %: % is % in the software but still on the register; it will not be depreciated', r.ord, r.asset_code, r.status;")
    w('  END LOOP;')
    w('END $$;')
    w('COMMIT;')
    with open(OUT_SQL, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(L) + '\n')

def main():
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    rows = load(sys.argv[1])
    items, review = build(rows)
    write_sql(items, rows)
    with open(OUT_CSV, 'w', encoding='utf-8-sig', newline='') as fh:
        wr = csv.DictWriter(fh, fieldnames=['row', 'name', 'group', 'cost', 'note'])
        wr.writeheader(); wr.writerows(review)
    sch = [i for i in items if i['sched']]
    print(f'rows {len(items)}  purchase value {sum(i["cost"] for i in items):,.2f}')
    print(f'2025 schedules {len(sch)}: WDV 31-3-2026 {sum(i["sched"][2] for i in sch):,.2f}, '
          f'depreciation 2025-26 {sum(i["sched"][1] for i in sch):,.2f}')
    print('by team', Counter(i['team'] for i in items))
    print('by category', Counter(i['category'] for i in items).most_common())
    print('by location', Counter(i['location'] for i in items).most_common())
    print('methods', Counter(i['method'] for i in items).most_common())
    print(f'review rows {len(review)} -> {OUT_CSV}')
    print(f'wrote {OUT_SQL}')

if __name__ == '__main__':
    main()
