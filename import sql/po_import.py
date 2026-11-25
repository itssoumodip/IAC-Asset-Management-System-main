"""IT purchase orders → asset software, one category at a time.

Usage:
  python -I "import sql/po_import.py" parse  <PO workbook.xlsx>            writes po-lines.json
  python -I "import sql/po_import.py" match  <category> <it_assets.json>  writes po-<category>-match.csv
  python -I "import sql/po_import.py" sql    <category>                   writes po-<category>-import.sql
                                                                          from the (reviewed) match CSV

The PO sheet is a run of printed purchase orders (header, QTY / DESCRIPTION / USER NAME /
UNIT PRICE / TOTAL lines, GST, total, vendor). Prices on the POs are before GST; the asset cost
is the price including GST (18% unless the PO says otherwise), like the finance books.
"""
import csv, datetime, json, os, re, sys
from collections import Counter
from difflib import SequenceMatcher

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
LINES = os.path.join(HERE, 'po-lines.json')

# ------------------------------------------------------------------------------------------
# Parsing the printed POs

def num(v):
    try: return float(str(v).replace(',', ''))
    except (TypeError, ValueError): return None

DATE_PATTERNS = ('%d-%m-%Y', '%d.%m.%y', '%d.%m.%Y', '%d-%m-%y', '%d/%m/%Y', '%d/%m/%y', '%d.%m.%Y')

def parse_text_date(s):
    s = re.split(r'\s*\|', s)[0].strip().rstrip('.')
    for p in DATE_PATTERNS:
        try: return datetime.datetime.strptime(s, p).date()
        except ValueError: pass
    return None

def parse(path):
    ws = openpyxl.load_workbook(path, data_only=True, read_only=True)['PO']
    rows = [list(r) for r in ws.iter_rows(values_only=True) if any(c not in (None, '') for c in r)]
    pos, cur, mode = [], None, None
    for r in rows:
        c = [x for x in r if x not in (None, '')]
        first = str(c[0]).strip() if c else ''
        up = first.upper()
        joined = ' | '.join(str(x) for x in c)
        m = re.search(r'PO\s*NO\s*[:\-]?\s*([A-Z]+/[A-Za-z]+/\d+)', joined, re.I)
        if m:
            when = next((x for x in c if isinstance(x, datetime.datetime)), None)
            text_date = re.search(r'Date\s*[:\-]?\s*([0-9][0-9.\-/]+)', joined, re.I)
            cur = {'po': m.group(1), 'date_cell': when.date().isoformat() if when else None,
                   'date_text': text_date.group(1) if text_date else None, 'lines': [], 'vendor': None,
                   'notes': [], 'gst_included': False}
            pos.append(cur); mode = None; continue
        if cur is None: continue
        if up == 'QTY': mode = 'items'; continue
        if re.match(r'^(C|S|I)?GST', up):
            mode = 'after'; continue
        if up.startswith('TOTAL') or up.startswith('ROUND OFF'):
            if up.startswith('TOTAL'): cur['total'] = num(c[-1])
            mode = 'after'; continue
        if up.startswith('PAYMENTS DETAILS') or up.startswith('VENDOR'):
            cur['vendor'] = str(c[-1]).strip() if len(c) > 1 and not str(c[-1]).upper().startswith('VENDOR') else cur['vendor']
            mode = 'vendor'; continue
        if up.startswith(('ADDRESS', 'CONTACT', 'PHONE', 'APPROVAL', 'IAC PATRONS', '3RD FLOOR', '5A,')):
            if up.startswith('IAC PATRONS'): mode = None
            continue
        if 'INCLUSIVE OF ALL' in joined.upper() or 'GST @18% INCLUDED' in joined.upper():
            cur['gst_included'] = True
        if mode == 'items':
            q = num(r[0]) if r and r[0] not in (None, '') else None
            texts = [str(x).strip() for x in c if not isinstance(x, (int, float))]
            nums = [x for x in c if isinstance(x, (int, float))]
            if q is not None and q > 0 and texts and not re.match(r'^(C|S|I)?GST', texts[0].upper()):
                cur['lines'].append({'qty': q, 'desc': texts[0], 'user': texts[1] if len(texts) > 1 else None,
                                     'unit': nums[1] if len(nums) > 1 else None,
                                     'total': nums[2] if len(nums) > 2 else None, 'more': []})
            elif cur['lines'] and texts:
                L = cur['lines'][-1]
                L['more'].append(' '.join(texts))
                if not L['user'] and len(texts) > 1: L['user'] = texts[1]
                if L['unit'] is None and nums: L['unit'] = nums[0]
            elif texts:
                cur['notes'].append(joined)
        else:
            cur['notes'].append(joined)
    fix_dates(pos)
    return pos

def fix_dates(pos):
    """Typed dates are day-first. Excel turned some into real dates with day and month swapped
    (12.06.25 → 2025-12-06). For a cell date with day ≤ 12, take whichever reading sits between
    the neighbouring POs' dates."""
    text = [parse_text_date(p['date_text']) if p['date_text'] else None for p in pos]
    for i, p in enumerate(pos):
        d = text[i]
        if d is None and p['date_cell']:
            cell = datetime.date.fromisoformat(p['date_cell'])
            options = [cell]
            if cell.day <= 12: options.append(datetime.date(cell.year, cell.day, cell.month))
            prev = next((x for x in reversed(text[:i]) if x), None)
            nxt = next((x for x in text[i + 1:] if x), None)
            def cost(o):
                c = 0
                if prev: c += max(0, (prev - o).days)
                if nxt: c += max(0, (o - nxt).days)
                return c
            d = min(options, key=cost)
            text[i] = d
        p['date'] = d.isoformat() if d else None
        p['date_note'] = None
    # A typed date a year behind its neighbours (07-01-2025 between Dec 2025 and Mar 2026) is a
    # typo for the next year.
    for i, p in enumerate(pos):
        if not p['date']: continue
        d = datetime.date.fromisoformat(p['date'])
        prev = next((datetime.date.fromisoformat(x['date']) for x in reversed(pos[:i]) if x['date']), None)
        if prev and (prev - d).days > 200:
            bumped = datetime.date(d.year + 1, d.month, min(d.day, 28) if d.month == 2 else d.day)
            if abs((bumped - prev).days) < (prev - d).days:
                p['date'] = bumped.isoformat(); p['date_note'] = f'PO says {d.isoformat()}; taken as {bumped.isoformat()} from the PO order'
    # No date at all: the previous PO's date, for matching only (never saved as the purchase date).
    last = None
    for p in pos:
        if p['date']: last = p['date']; p['date_estimated'] = False
        else: p['date'] = last; p['date_estimated'] = True; p['date_note'] = 'no date on the PO'

# ------------------------------------------------------------------------------------------
# Picking a category's items

CATEGORIES = {
    'laptops': {
        'want': re.compile(r'laptop|15-?fc|15s-?fq|x1[45]04|vivo ?book|loq|macbook|victus|ryzen|core.?i3|intel.? core|i3-1215u', re.I),
        # Checked against the start of the line only: laptop specs mention SSD, bag, warranty...
        'skip': re.compile(r'warranty|adapt|keyboard|mouse|ryzen 9|rtx|motherboard|^\s*\d+\s*gb', re.I),
        'min_unit': 20000,
        'type': lambda text: ('IT Hardware', 'Laptop'),
    },
    'mouse-adapters': {
        'want': re.compile(r'mouse|adapt[eo]r|logitech|hdmi convert', re.I),
        'skip': re.compile(r'^\s*power (cord|code)', re.I),
        'min_unit': 0,
        # Price incl. GST from the PO's own total (some vendors bill without GST).
        'gst_from_total': True,
        'type': lambda text: ('IT Hardware', 'Keyboard & Mouse') if re.search(r'mouse|keyboard|logitech', text, re.I)
                             else ('IT Hardware', 'Charger & Adapter'),
    },
}
# Subcategories the software may not have yet: code → needs a custodian (held by a person)?
NEW_TYPES = {'Charger & Adapter': True}
SN = re.compile(r'(?:S/?N|SL\s*No)\s*[:\-]*\s*([A-Z0-9]{6,})', re.I)

PLACE = re.compile(r'\b(site|sirakol|floor|room|office|academy|common|shared|team|block|board)\b', re.I)

def people(user, qty):
    if not user: return [None] * qty
    # A place ("Sirakol, Site") applies to every unit; only lists of names are split.
    if PLACE.search(user) and not re.search(r'\n|\d\.', user): return [user.replace('\n', ' ').strip()] * qty
    parts = [re.sub(r'^\d+\.\s*', '', p).strip(' ,') for p in re.split(r'[\n,]+|\s{2,}', user)]
    parts = [p for p in parts if p and not re.match(r'^(will provide name later|stock)$', p, re.I)]
    return (parts + [None] * qty)[:qty] if qty > 1 else [user.replace('\n', ' ').strip()]

SERIAL = re.compile(r'\b(5CD[0-9A-Z]{7}|SPF[0-9A-Z]{6}|[A-Z0-9]{2}N0[A-Z0-9]{8,12}|JYVT[0-9A-Z]{6})\b')

def pick(pos, category):
    rule = CATEGORIES[category]
    out = []
    for p in pos:
        for n, L in enumerate(p['lines']):
            text = ' '.join([L['desc']] + L['more'] + [x for x in p['notes'] if 'laptop' in x.lower()])
            if not rule['want'].search(text) or rule['skip'].search(L['desc'][:45]): continue
            if not L['unit'] or L['unit'] < rule['min_unit']: continue
            qty = int(L['qty'])
            gst = 1.0 if p['gst_included'] else 1.18
            if rule.get('gst_from_total') and p.get('total'):
                base = sum(x['qty'] * x['unit'] for x in p['lines'] if x['unit'])
                ratio = p['total'] / base if base else 0
                if 0.99 <= ratio <= 1.30: gst = ratio
            serials = SERIAL.findall(text) or SN.findall(' '.join([L['desc']] + L['more']))
            cat, typ = rule['type'](L['desc'])
            for k, person in enumerate(people(L['user'], qty)):
                out.append({
                    'category': cat, 'asset_type': typ,
                    'po': p['po'], 'line': n + 1, 'unit_no': k + 1, 'date': p['date'],
                    'date_estimated': p.get('date_estimated', False), 'date_note': p.get('date_note'), 'vendor': p['vendor'],
                    'description': re.sub(r'\s+', ' ', L['desc'])[:200], 'person': person,
                    'price_ex_gst': round(L['unit'], 2), 'price_incl_gst': round(L['unit'] * gst, 2),
                    'serial_on_po': serials[k] if k < len(serials) else (serials[0] if len(serials) == 1 and qty == 1 else None),
                })
    return out

# ------------------------------------------------------------------------------------------
# Matching to assets already in the software

def norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())

def model_key(s):
    s = norm(s)
    for k in ('15fc0389', '15fc0690', '15fc0155', '15fc0154', '15fc0030', 'x1504vap', 'x1504va', 'x1404va', 'x1605', 'loq', 'victus', 'macbook', 'mac', '15sfq5327', '15sfq5326', 'i31215u'):
        if k in s: return {'mac': 'macbook', 'i31215u': '15sfq5327'}.get(k, k)
    return None

def name_hit(a, b):
    if not a or not b: return False
    ta = {t for t in re.split(r'\W+', a.lower()) if len(t) > 2 and t not in ('sir', 'site', 'for', 'the', 'team', 'intern', 'office', 'ceo', 'department', 'floor', 'room')}
    tb = {t for t in re.split(r'\W+', b.lower()) if len(t) > 2}
    # Close spellings count (Sharmishtha / Sharmistha, Chaudhuri / Chaudhary).
    return any(x == y or (len(x) > 4 and SequenceMatcher(None, x, y).ratio() >= 0.8) for x in ta for y in tb)

RARE_MODELS = {'victus', 'macbook', 'loq', 'x1605', 'x1404va', 'x1504vap'}

def match(items, assets):
    # Only assets of the same subcategories are candidates.
    kinds = {it['asset_type'] for it in items}
    laptops = [a for a in assets if a['asset_type'] in kinds]
    # Serials copied from one PO to the next (107-112 all show 5CD3341GHJ) prove nothing.
    serial_count = Counter(norm(it['serial_on_po']) for it in items if it['serial_on_po'])
    scored = []
    for i, it in enumerate(items):
        d = datetime.date.fromisoformat(it['date']) if it['date'] else None
        for a in laptops:
            why, score = [], 0
            if it['serial_on_po'] and serial_count[norm(it['serial_on_po'])] == 1 and norm(a['serial_number']) == norm(it['serial_on_po']):
                score += 100; why.append('same serial')
            cost = a['purchase_cost']
            exact_price = bool(cost) and abs(cost - it['price_incl_gst']) <= max(60, 0.015 * cost)
            if exact_price:
                score += 30; why.append('same price')
            elif cost and abs(cost - it['price_incl_gst']) <= 0.08 * cost:
                score += 10; why.append('similar price')
            gap = None
            if d and a['purchase_date']:
                gap = (datetime.date.fromisoformat(a['purchase_date']) - d).days
                if -3 <= gap <= 45: score += 25 - min(20, max(0, gap) // 3); why.append(f'bought {gap:+d} days from PO')
                elif -20 <= gap < -3: score += 8; why.append(f'bought {gap:+d} days from PO')
                elif abs(gap) > 200: score -= 40
            if exact_price and gap is not None and abs(gap) <= 7 and not it['date_estimated']:
                score += 15
            mk, ma = model_key(it['description']), model_key(' '.join(filter(None, [a['model'], a['description']])))
            if mk and ma:
                if mk == ma: score += 35 if mk in RARE_MODELS else 20; why.append('same model')
                else: score -= 10; why.append(f'model differs ({ma} in software)')
            held = [a['holder']] + (a['previous'] or [])
            if any(name_hit(it['person'], h) for h in held if h):
                score += 35; why.append('same person')
            if score >= 50: scored.append((score, i, a['asset_code'], '; '.join(why)))
    scored.sort(reverse=True)
    used_items, used_assets, result = set(), set(), {}
    for score, i, code, why in scored:
        if i in used_items or code in used_assets: continue
        used_items.add(i); used_assets.add(code)
        result[i] = (code, score, why)
    by_code = {a['asset_code']: a for a in laptops}
    rows = []
    for i, it in enumerate(items):
        code, score, why = result.get(i, (None, None, None))
        a = by_code.get(code)
        rows.append({**it, 'action': 'fill' if code else 'new', 'asset_code': code or '', 'confidence': score or '',
                     'why': why or 'no laptop in the software matches', 'asset_holder': (a or {}).get('holder') or '',
                     'asset_cost': (a or {}).get('purchase_cost') or '', 'asset_bought': (a or {}).get('purchase_date') or ''})
    return rows

# ------------------------------------------------------------------------------------------
# Writing the import SQL from the (reviewed) match CSV

TYPES = {'laptops': ('IT Hardware', 'Laptop')}

def q(v):
    if v is None or v == '': return 'NULL'
    if isinstance(v, (int, float)): return repr(round(v, 2))
    return "'" + str(v).replace("'", "''") + "'"

def short_description(desc):
    first = re.split(r'\s*/\s*|\n|\t', desc)[0].strip()
    first = re.sub(r'\s{2,}', ' ', first)
    return (first if len(first) >= 6 else desc[:80]).strip()[:150]

def write_sql(category):
    default_cat, default_typ = CATEGORIES[category]['type']('')
    rows = list(csv.DictReader(open(os.path.join(HERE, f'po-{category}-match.csv'), encoding='utf-8-sig')))
    serial_count = Counter(norm(r['serial_on_po']) for r in rows if r['serial_on_po'])
    vals = []
    for n, r in enumerate(rows, start=1):
        action = r['action'].strip().lower()
        if action not in ('fill', 'new', 'skip'): raise SystemExit(f'row {n}: action must be fill, new or skip')
        if action == 'skip': continue
        if action == 'fill' and not r['asset_code'].strip(): raise SystemExit(f'row {n}: fill needs an asset_code')
        estimated = r['date_estimated'].strip().lower() == 'true'
        date = None if estimated else (r['date'] or None)
        serial = r['serial_on_po'] if r['serial_on_po'] and serial_count[norm(r['serial_on_po'])] == 1 else None
        meta = {k: v for k, v in {
            'po': r['po'], 'line': int(r['line']), 'unit': int(r['unit_no']), 'date': r['date'] or None,
            'dateNote': r['date_note'] or None, 'vendor': r['vendor'] or None, 'person': r['person'] or None,
            'priceExGst': float(r['price_ex_gst']), 'priceInclGst': float(r['price_incl_gst']),
            'description': r['description'],
        }.items() if v is not None}
        remark = f"PO {r['po']}" + (f" ({r['date']})" if r['date'] else '') + (f" for {r['person']}" if r['person'] else '') + '.'
        vals.append('  (' + ', '.join([
            str(n), q(action), q(r['asset_code'].strip() or None), q(short_description(r['description'])),
            q(serial), q(float(r['price_incl_gst'])), (f"DATE '{date}'" if date else 'NULL'), q(r['vendor'] or None),
            q(json.dumps(meta, ensure_ascii=False)) + '::jsonb', q(remark),
            q(r.get('category') or default_cat), q(r.get('asset_type') or default_typ),
        ]) + ')')
    tag = f'po-{category}'
    L = [
        f'-- IT purchase orders: {category}. Generated by po_import.py from po-{category}-match.csv; safe to read.',
        '-- "fill" rows add the PO price (incl. GST), date and vendor to an existing asset where those are blank,',
        '-- and record the PO on it. "new" rows create the asset (In Store, IT team, finance review pending).',
        '-- Sends NO notifications. Refuses to run twice.',
        '\\set ON_ERROR_STOP on',
        'BEGIN;',
        'DO $$ BEGIN',
        f"  IF EXISTS (SELECT 1 FROM audit_events WHERE action = 'PO_IMPORTED' AND changes->>'tag' = '{tag}') THEN",
        f"    RAISE EXCEPTION 'The {category} from the purchase orders were already imported.';",
        '  END IF;',
        'END $$;',
        "CREATE TEMP TABLE importer ON COMMIT DROP AS",
        "  SELECT ur.user_id AS id FROM user_roles ur WHERE ur.role_code='SUPER_ADMIN' ORDER BY ur.granted_at LIMIT 1;",
        'CREATE TEMP TABLE po (n int PRIMARY KEY, action text, asset_code text, description text, serial text,',
        '  price numeric, po_date date, vendor text, meta jsonb, remark text, category text, asset_type text, asset_id uuid) ON COMMIT DROP;',
        'INSERT INTO po (n, action, asset_code, description, serial, price, po_date, vendor, meta, remark, category, asset_type) VALUES',
        ',\n'.join(vals) + ';',
        '',
        "UPDATE po SET asset_id = a.id FROM assets a WHERE po.action = 'fill' AND a.asset_code = po.asset_code AND a.removed_at IS NULL;",
        "DO $$ DECLARE r record; BEGIN",
        "  FOR r IN SELECT n, asset_code FROM po WHERE action = 'fill' AND asset_id IS NULL LOOP",
        "    RAISE EXCEPTION 'Row %: asset % is not in the software (or was removed). Fix the CSV and regenerate.', r.n, r.asset_code;",
        '  END LOOP;',
        'END $$;',
        '',
        '-- Existing assets: blanks only; the PO is recorded on the asset either way.',
        'UPDATE assets a SET',
        '  purchase_cost = coalesce(a.purchase_cost, po.price),',
        '  purchase_date = coalesce(a.purchase_date, po.po_date),',
        "  supplier = coalesce(nullif(btrim(a.supplier), ''), po.vendor),",
        "  remarks = CASE WHEN coalesce(a.remarks, '') LIKE '%' || (po.meta->>'po') || '%' THEN a.remarks",
        "                 ELSE nullif(concat_ws(' ', nullif(btrim(a.remarks), ''), po.remark), '') END,",
        "  legacy_metadata = coalesce(a.legacy_metadata, '{}'::jsonb) || jsonb_build_object('purchaseOrder', po.meta),",
        '  version = a.version + 1, updated_at = now()',
        "FROM po WHERE po.action = 'fill' AND a.id = po.asset_id;",
        '',
        '-- Subcategories this import uses that the software does not have yet (held by a person).',
        *[f"INSERT INTO reference_values(kind, code, label) VALUES ('ASSET_TYPE', {q(t)}, {q(t)}) ON CONFLICT (kind, code) DO NOTHING;" for t in NEW_TYPES],
        *[f"INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code, owning_team_id, handling_team_id) SELECT {q(t)}, {'true' if personal else 'false'}, 'IT Hardware', handling_team_id, handling_team_id FROM category_policies WHERE category_code = 'IT Hardware' ON CONFLICT (asset_type_code) DO NOTHING;" for t, personal in NEW_TYPES.items()],
        '-- New assets, numbered from the IT counter.',
        "SELECT pg_advisory_xact_lock(hashtextextended('iac-asset-sequence', 0));",
        'DO $$ DECLARE r record; nxt bigint; prefix text; acode text; tid uuid; aid uuid; BEGIN',
        "  SELECT id INTO tid FROM teams WHERE code = 'IT';",
        "  FOR r IN SELECT * FROM po WHERE action = 'new' ORDER BY n LOOP",
        '    SELECT k.next_value, t.asset_code_prefix INTO nxt, prefix FROM team_asset_counters k JOIN teams t ON t.id = k.team_id',
        '     WHERE k.team_id = tid FOR UPDATE OF k;',
        "    LOOP acode := 'IAC-' || prefix || '-' || lpad(nxt::text, 6, '0');",
        '      EXIT WHEN NOT EXISTS (SELECT 1 FROM assets WHERE asset_code = acode); nxt := nxt + 1; END LOOP;',
        '    UPDATE team_asset_counters SET next_value = nxt + 1 WHERE team_id = tid;',
        '    INSERT INTO assets(asset_code, category, asset_type, description, serial_number, ownership_type, status, condition,',
        '      risk_level, owning_team_id, purchase_date, purchase_cost, currency, supplier, finance_pending, finance_status,',
        '      remarks, legacy_metadata, created_by)',
        "    VALUES (acode, r.category, r.asset_type, r.description, r.serial, 'Owned', 'In Store', 'Unknown', 'Low', tid,",
        "      r.po_date, r.price, 'INR', r.vendor, true, 'PENDING', r.remark, jsonb_build_object('purchaseOrder', r.meta),",
        '      (SELECT id FROM importer))',
        '    RETURNING id INTO aid;',
        '    UPDATE po SET asset_id = aid, asset_code = acode WHERE n = r.n;',
        '  END LOOP;',
        'END $$;',
        '',
        'INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)',
        "SELECT (SELECT id FROM importer), 'USER', 'asset', po.asset_id,",
        "       CASE WHEN po.action = 'new' THEN 'ASSET_CREATED' ELSE 'ASSET_UPDATED' END,",
        "       jsonb_build_object('source', 'IT purchase orders', 'po', po.meta->>'po', 'assetCode', po.asset_code), gen_random_uuid()",
        '  FROM po;',
        'INSERT INTO audit_events(actor_id, actor_kind, entity_type, entity_id, action, changes, request_id)',
        f"SELECT (SELECT id FROM importer), 'USER', 'import', NULL, 'PO_IMPORTED', jsonb_build_object('tag', '{tag}',",
        "  'filled', (SELECT count(*) FROM po WHERE action = 'fill'), 'created', (SELECT count(*) FROM po WHERE action = 'new')), gen_random_uuid();",
        'DO $$ DECLARE r record; BEGIN',
        "  RAISE NOTICE 'Filled from POs: %, created: %', (SELECT count(*) FROM po WHERE action = 'fill'), (SELECT count(*) FROM po WHERE action = 'new');",
        "  FOR r IN SELECT n, asset_code, meta->>'po' AS po, meta->>'person' AS person FROM po WHERE action = 'new' ORDER BY n LOOP",
        "    RAISE NOTICE 'New % from % %', r.asset_code, r.po, coalesce('for ' || r.person, '');",
        '  END LOOP;',
        'END $$;',
        'COMMIT;',
    ]
    out = os.path.join(HERE, f'po-{category}-import.sql')
    open(out, 'w', encoding='utf-8', newline='\n').write('\n'.join(L) + '\n')
    print(f'{len(vals)} rows -> {out}')

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'parse':
        pos = parse(sys.argv[2])
        json.dump(pos, open(LINES, 'w', encoding='utf-8'), indent=1)
        print(f'{len(pos)} POs, {sum(len(p["lines"]) for p in pos)} lines -> {LINES}')
    elif cmd == 'match':
        cat, assets = sys.argv[2], json.load(open(sys.argv[3], encoding='utf-8-sig'))
        items = pick(json.load(open(LINES, encoding='utf-8')), cat)
        rows = match(items, assets)
        out = os.path.join(HERE, f'po-{cat}-match.csv')
        with open(out, 'w', encoding='utf-8-sig', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
        print(f'{len(rows)} {cat}: {Counter(r["action"] for r in rows)} -> {out}')
        for r in rows:
            print(f"{r['po']:<20} {r['date'] or '?':<10} {(r['person'] or '-')[:26]:<26} {r['price_incl_gst']:>10,.0f}  "
                  f"{r['action']:<4} {r['asset_code']:<14} {str(r['confidence']):>4} {r['why'][:70]}  [{r['asset_holder'][:20]}]")
    elif cmd == 'sql':
        write_sql(sys.argv[2])
    else:
        raise SystemExit(__doc__)

if __name__ == '__main__':
    main()
