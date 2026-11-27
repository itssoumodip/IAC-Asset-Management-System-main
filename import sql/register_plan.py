"""Builds the IT plan from the finance fixed asset register: one plan row per register row, saying
what to do with it against what the software already has. Read-only; review the plan, then
    python -I "import sql/register_import.py" "import sql/register-it-plan.csv"

Usage:
  python -I "import sql/register_plan.py" <live-assets.csv> <Fixed asset 26-27.xlsx> <PO workbook.xlsx> <staff.txt>

  live-assets.csv  every live asset (same export as it-reconcile.py; legacy_metadata included)
  staff.txt        current staff names, one per line (for matching the register's custodian)

Decisions per register row
  skip  already imported (an asset carries this register row), or a software licence (those
        belong in Subscriptions, not the asset register)
  fill  the asset is in the software: matched by serial, bill + cost, purchase date + cost, through
        IT's laptop sheet, or as N identical machines on one register row (cost = N x unit price).
        Only blanks are filled; the plan's note lists any cost or date that disagrees.
  new   units the software does not have: one asset per unit, unit cost = row cost / quantity.
        Model, serial and configuration come from IT's laptop sheet when it has the item.
        Holder: the register custodian (or laptop sheet user) when it names one current staff
        member exactly; status follows (In Use with a holder, Broken if "dead", otherwise In Store
        for personal kit and In Use for room equipment). Condition "Good" unless dead: not
        physically checked, so every new row says so.
Writes register-it-plan.csv next to this script and prints a summary.
"""
import csv, importlib.util, json, os, re, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('rec', os.path.join(HERE, 'it-reconcile.py'))
rec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rec)
far = rec.far

OUT = os.path.join(HERE, 'register-it-plan.csv')

# Register subcategory → software subcategory (category, subcategory); None = not an asset here.
LICENCE = {'Business Software', 'Website', 'Design Software'}
NEEDS_HOLDER = {'Laptop', 'Desktop', 'Tablet', 'Mobile Phone', 'Camera', 'Charger & Adapter', 'Docking Station',
                'External Storage', 'Keyboard & Mouse', 'Monitor'}

PER_UNIT = {'Laptop', 'Desktop', 'Tablet', 'Mobile Phone', 'Monitor', 'Printer', 'Camera', 'Scanner'}
PERSONAL_DEVICES = {'Laptop', 'Desktop', 'Tablet'}      # IT tracks these one by one: never guess-create
# Register rows whose quantity column says 1 but which are several machines (cost = n x unit price,
# confirmed against the software and IT's laptop sheet).
UNITS_OVERRIDE = {411: 2, 418: 2, 419: 2}
# Register rows tied to specific assets by IT's laptop sheet (vendor, date, person), where price
# and date alone would pick the wrong machine of a batch.
FILL_OVERRIDE = {
    411: (['IAC-IT-000196', 'IAC-IT-000197'], 'two Intel NUC desktops with Samsung monitors (PO 084)'),
    418: (['IAC-IT-000044', 'IAC-IT-000045'], 'laptop sheet: Priyanka (5CD3341GHJ) and Neeraj/Abhik (5CD333FFR9)'),
    419: (['IAC-IT-000043', 'IAC-IT-000046'], 'laptop sheet: Souradeep (5CD547CDY5) and Shantanu (5CD547CDYM)'),
    471: (['IAC-IT-000041', 'IAC-IT-000042'], 'laptop sheet: Optima laptops of Payel and Dr. Nandita (13 May 2026)'),
    230: (['IAC-IT-000055'], 'laptop sheet: HP 14s-dq2 of Barnali, bought second-hand from Ratnabali; '
                            'finance book cost 5000 vs 39500 in the software - Finance to confirm'),
}

def text_of(r):
    return ' '.join(filter(None, [r['name'], r['sub'], r['model']])).lower()

def not_it(r):
    """Register rows the IT classifier picked up that belong to another team."""
    t = text_of(r)
    if re.search(r'microwave|\bmwo\b|\boven\b', t): return 'kitchen equipment (Admin team), not IT'
    return None

def software_type(r):
    cat, typ = r['category'], r['type']
    t = text_of(r)
    if typ in ('Laptop', 'Tablet') and re.search(r'\bnuc\b|desktop|imac', t): return 'IT Hardware', 'Desktop'
    if re.search(r'tempered|defender case|\bcover\b|\bcase\b', t) and cat == 'IT Hardware': return 'IT Hardware', 'IT Accessory'
    if cat == 'Audio Visual' and re.search(r'\bstand\b|\bwires?\b|batter|charger', t): return 'Audio Visual', 'Studio Equipment'
    if typ == 'Camera & Studio Equipment':
        t = ' '.join(filter(None, [r['name'], r['sub'], r['model']])).lower()
        if 'camera' in t and not re.search(r'batter|charger|lens|tripod|light|stand|bag|card', t):
            return 'Audio Visual', 'Camera'
        return 'Audio Visual', 'Studio Equipment'
    return cat, typ

BRANDS = ['HP', 'Lenovo', 'Asus', 'Dell', 'Apple', 'LG', 'Samsung', 'Panasonic', 'Epson', 'Canon', 'Hikvision',
          'CP Plus', 'Sony', 'Godox', 'Sennheiser', 'Logitech', 'BenQ', 'Seagate', 'SanDisk', 'WD', 'TP-Link',
          'Cisco', 'Brother', 'Xiaomi', 'Redmi', 'JBL', 'Boat', 'Microtek', 'Luminous', 'APC', 'TimeWatch', 'eSSL',
          'Intel', 'Acer', 'MSI', 'Zebronics', 'Bose', 'Yamaha', 'Ahuja', 'DJI', 'Rode', 'Boya']

def brand_of(*texts):
    t = ' '.join(filter(None, texts))
    for b in BRANDS:
        if re.search(rf'(?<![A-Za-z]){re.escape(b)}(?![A-Za-z])', t, re.I): return b
    if re.search(r'\b(imac|macbook|ipad|iphone)\b', t, re.I): return 'Apple'
    if re.search(r'\b(ideapad|thinkpad|yoga|loq)\b', t, re.I): return 'Lenovo'
    if re.search(r'\b(vivobook|nuc)\b', t, re.I): return 'Asus' if 'vivo' in t.lower() else 'Intel'
    if re.search(r'\b(pavilion|victus|envy|15s?-f[a-z])', t, re.I): return 'HP'
    return None

# Register location / custodian text → software location code. The project site is Sirakol (as
# corrected in the app); its buildings are created by register-masters.sql.
SITE_BUILDINGS = {  # code → name (BUILDING inside IAC-SITE-SIRAKOL)
    'IAC-SITE-SIRAKOL-OFFICE': 'Site Office', 'IAC-SITE-SIRAKOL-SB': 'Security Block & Guard House',
    'IAC-SITE-SIRAKOL-CANTEEN': 'Canteen & Store', 'IAC-SITE-SIRAKOL-PORTA': 'Porta Cabin',
}

def location_code(r):
    t = ' '.join(filter(None, [r['location'], r['custodian'], r['name']])).lower()
    for words, code in (
        (('amtal',), None), (('asmc',), 'ASMC'), (('3rd floor', '3rd flooar', 'fmc 3rd'), 'IAC-HO-3F'),
        (('2nd floor', 'fmc 2nd'), 'IAC-HO-2F'), (('ground floor', 'training academy', 'fmc ground'), 'IAC-HO-GF'),
        (('security block', 'guard house', 'sb+gh'), 'IAC-SITE-SIRAKOL-SB'),
        (('site office', 'site - office', 'site-office'), 'IAC-SITE-SIRAKOL-OFFICE'), (('canteen',), 'IAC-SITE-SIRAKOL-CANTEEN'),
        (('porta',), 'IAC-SITE-SIRAKOL-PORTA'), (('community cent', 'coomunity', 'sirakol'), 'IAC-SITE-SIRAKOL'),
    ):
        if any(w in t for w in words): return code
    loc = (r['location'] or '').lower()
    if loc.startswith(('site', 'project site')) or (r['custodian'] or '').lower().startswith('site'): return 'IAC-SITE-SIRAKOL'
    if loc.startswith(('ho', 'head office')): return 'IAC-HO'
    return None

GENERIC = {'it', 'ho', 'site', 'admin', 'team', 'store', 'in', 'room', 'board', 'dead', 'common', 'office', 'the',
           'department', 'dept', 'research', 'finance', 'clinical', 'stock', 'and', 'for', 'used', 'guard', 'house'}

def holder_of(text, staff):
    if not text: return None
    t = re.sub(r'\(.*?\)', ' ', str(text)).lower()
    t = re.split(r'->|>|/|,|\n', t)[-1]                 # "A -> B" means B has it now
    tokens = [w for w in re.findall(r'[a-z]+', t) if len(w) >= 3]
    if not tokens or tokens[0] in GENERIC or all(w in GENERIC for w in tokens): return None
    exact = [s for s in staff if s.lower() == ' '.join(tokens)]
    if len(exact) == 1: return exact[0]
    hits = []
    for s in staff:
        parts = re.findall(r'[a-z]+', s.lower())
        if parts and parts[0].startswith(tokens[0][:5]) and tokens[0].startswith(parts[0][:5]) \
                and all(any(p.startswith(w[:4]) for p in parts) for w in tokens[1:]):
            hits.append(s)
    return hits[0] if len(hits) == 1 else None

def dead(r):
    return bool(re.search(r'\bdead\b|not working|scrap', ' '.join(filter(None, [r['custodian'], r['name']])), re.I))

def clean_item(name):
    return re.sub(r'\s+', ' ', re.sub(r'(?i)^computer\s*-\s*', '', name)).strip(' -')

def main():
    prod_all = rec.load_prod(sys.argv[1])
    reg = rec.load_register(sys.argv[2])
    lap = rec.load_laptops(sys.argv[3])
    staff = [s.strip() for s in open(sys.argv[4], encoding='utf-8-sig') if s.strip()]

    # A register row is decided once any asset (live, or removed by a person) carries it.
    done_rows, removed_rows, prod = set(), set(), []
    for p in prod_all:
        meta = json.loads(p['legacy']) if p.get('legacy') else {}
        fr = (meta or {}).get('financeRegister')
        if fr and fr.get('row'):
            done_rows.add(int(fr['row']))
            if p.get('removed') == 't': removed_rows.add(int(fr['row']))
        elif p.get('removed') != 't':
            prod.append(p)
    for r in reg:
        n = UNITS_OVERRIDE.get(r['row'])
        if n: r.update(units=n, unit_cost=round(r['cost'] / n, 2))
        r['category'], r['type'] = software_type(r)
    todo = [r for r in reg if r['row'] not in done_rows and not not_it(r) and r['type'] not in LICENCE]

    lap_of, reg_of, reg_left, reg_lap, lap_used = rec.match(prod, todo, lap)
    # The weakest matcher (same price, nearest date) may pair the wrong machine: keep it only when
    # the dates are within a month.
    for pid, (r, how) in list(reg_of.items()):
        p = next(x for x in prod if x['id'] == pid)
        if how.startswith('cost only') and rec.days_apart(p['date'], r['dop']) > 30:
            del reg_of[pid]; reg_left[r['row']] += 1
    by_row = defaultdict(list)
    for pid, (r, how) in reg_of.items(): by_row[r['row']].append((pid, how))
    used_assets = set(reg_of)

    # Confirmed pairings first: they take their assets away from any automatic match.
    code_to_id = {p['asset_code']: p['id'] for p in prod}
    for row, (codes, why) in FILL_OVERRIDE.items():
        if row in done_rows: continue
        ids = [code_to_id[c] for c in codes if c in code_to_id]
        if len(ids) != len(codes): raise SystemExit(f'override for register row {row}: {codes} not all live')
        for other in list(by_row):
            kept = [(pid, h) for pid, h in by_row[other] if pid not in ids]
            reg_left[other] += len(by_row[other]) - len(kept)
            by_row[other] = kept
        reg_left[row] += len(by_row[row])
        by_row[row] = [(pid, f'confirmed: {why}') for pid in ids]
        reg_left[row] -= len(ids)
        used_assets |= set(ids)

    # Near matches for what is still open: same subcategory, bought within 10 days, price within 5%
    # (delivery, rounding), or the same day with the price within 15%. Nearest date first.
    for r in sorted(todo, key=lambda x: x['dop'] or __import__('datetime').date.min):
        while reg_left[r['row']] > 0:
            best = None
            for p in prod:
                if p['id'] in used_assets or p['asset_type'] != r['type']: continue
                days = rec.days_apart(p['date'], r['dop'])
                if p['cost'] is None or not r['unit_cost']: continue
                gap = abs(p['cost'] - r['unit_cost']) / r['unit_cost']
                ok = (days <= 10 and gap <= 0.05) or (days <= 1 and gap <= 0.15)
                if ok and (best is None or (days, gap) < best[0]): best = ((days, gap), p)
            if not best: break
            (days, gap), p = best
            by_row[r['row']].append((p['id'], f'near match ({days} days, price {gap:.0%} apart) - check'))
            used_assets.add(p['id']); reg_left[r['row']] -= 1

    # N identical machines on one register row (row cost = N x the software's unit cost).
    for r in todo:
        if reg_left[r['row']] <= 0 or by_row[r['row']]: continue
        cat, typ = software_type(r)
        pool = defaultdict(list)
        for p in prod:
            if p['id'] in used_assets or p['cost'] is None or p['asset_type'] != typ: continue
            if rec.days_apart(p['date'], r['dop']) <= 20: pool[round(p['cost'], 2)].append(p)
        for cost, ps in pool.items():
            n = round(r['cost'] / cost) if cost else 0
            if n >= 2 and abs(r['cost'] - n * cost) <= 2 and len(ps) >= n:
                for p in ps[:n]:
                    by_row[r['row']].append((p['id'], f'{n} machines on one register row'))
                    used_assets.add(p['id'])
                reg_left[r['row']] = r['units'] - n if r['units'] > 1 else 0
                break

    prod_by_id = {p['id']: p for p in prod}
    plan, notes = [], Counter()
    for r in sorted(reg, key=lambda x: x['row']):
        cat, typ = r['category'], r['type']
        base = {
            'register_row': r['row'], 'item': r['name'], 'purchase_date': r['dop'] or '', 'capitalised': r['docap'] or '',
            'bill': r['bill'] or '', 'party': r['party'] or '', 'register_location': r['location'] or '',
            'register_custodian': r['custodian'] or '', 'team': 'IT', 'category': cat, 'subcategory': typ,
        }
        if r['row'] in done_rows:
            why = 'removed in the app after import - decided not to keep' if r['row'] in removed_rows else 'already imported'
            plan.append(dict(base, action='skip', how=why, unit_cost=r['cost'], units=r['units'])); notes[f'skip: {why}'] += 1; continue
        if not_it(r):
            plan.append(dict(base, action='skip', how=not_it(r), unit_cost=r['cost'], units=r['units'])); notes['skip: not IT'] += 1; continue
        if typ in LICENCE:
            plan.append(dict(base, action='skip', how='software licence - belongs in Subscriptions', unit_cost=r['cost'], units=r['units']))
            notes['skip: licence'] += 1; continue

        matched = by_row[r['row']]
        if matched:
            codes = [prod_by_id[pid]['asset_code'] for pid, _ in matched]
            differ = []
            for pid, _ in matched:
                p = prod_by_id[pid]
                if p['cost'] is not None and abs(p['cost'] - r['unit_cost']) > 2: differ.append(f"{p['asset_code']} cost {p['cost']:.0f} vs register {r['unit_cost']:.0f}")
                if p['date'] and r['dop'] and rec.days_apart(p['date'], r['dop']) > 3: differ.append(f"{p['asset_code']} bought {p['date']} vs register {r['dop']}")
            l = next((lap_of[pid] for pid, _ in matched if pid in lap_of), None)
            plan.append(dict(base, action='fill', asset_codes=' '.join(codes), units=len(codes),
                             unit_cost=round(r['unit_cost'] * len(codes), 2), how='; '.join(sorted({h for _, h in matched})),
                             model=(l and l['model']) or '', configuration=(l and rec.config_of(l)) if len(codes) == 1 and l else '',
                             manufacturer=brand_of(r['name'], r['model'], l and l['model']) or '',
                             note=('Disagrees: ' + '; '.join(differ)) if differ else ''))
            notes['fill'] += 1
            if differ: notes['fill with a disagreement to check'] += 1

        left = reg_left[r['row']]
        if left > 0 and typ in PERSONAL_DEVICES and not reg_lap.get(r['row']):
            # IT records every laptop/desktop/tablet; one missing from both the software and IT's
            # sheet is more likely a mismatch than a lost machine. A person decides.
            # Candidates: same subcategory, price within 5%, not tied to another register row.
            cands = sorted((p for p in prod if p['asset_type'] == typ and p['id'] not in used_assets and p['cost']
                            and abs(p['cost'] - r['unit_cost']) <= 0.05 * r['unit_cost']),
                           key=lambda p: rec.days_apart(p['date'], r['dop']))[:8]
            hint = ('Possible matches (same price): ' + ', '.join(f"{p['asset_code']} ({p['holder'] or 'nobody'}, {p['date'] or 'no date'})" for p in cands)) if cands else 'No asset in the software has this price.'
            plan.append(dict(base, action='review', units=left, unit_cost=round(r['unit_cost'] * left, 2),
                             how=f'{typ} on the register but not matched with confidence - check before adding',
                             model=r['model'] or '', serial=r['serial'] or '', note=hint))
            notes['review (personal devices)'] += 1
            left = 0
        if left > 0:
            ls = reg_lap.get(r['row'], [])
            l = ls[0] if len(ls) == 1 and left == 1 else None
            holder = holder_of(r['custodian'], staff) or (l and holder_of(l['current'] or l['user'], staff))
            broken = dead(r)
            if broken: status, cond = 'Broken', 'Not Working'
            elif holder: status, cond = 'In Use', 'Good'
            elif typ in NEEDS_HOLDER or re.search(r'store|stock', r['custodian'] or '', re.I): status, cond = 'In Store', 'Good'
            else: status, cond = 'In Use', 'Good'
            model = (l and l['model']) or r['model'] or ''
            serial = (l and l['serial'] and next(iter(l['serials']), None) and str(l['serial']).split()[0]) or (r['serial'] if left == 1 else '') or ''
            desc_bits = [brand_of(r['name'], model) or '', model if model and model.lower() not in clean_item(r['name']).lower() else '', clean_item(r['name'])]
            desc = re.sub(r'\s+', ' ', ' '.join(b for b in desc_bits if b)).strip()[:150]
            remark = ['Condition not physically checked.']
            if r['custodian'] and not holder and not broken: remark.append(f"Register custodian: {r['custodian']}.")
            if l: remark.append(f"Laptop sheet row {l['row']}.")
            if left < r['units']: remark.append(f"{left} of {r['units']} units on this register row.")
            # Batches of room equipment stay one asset (quantity in the description), as decided
            # with the asset owner; personal kit is one asset per unit.
            asset_units = left
            if left > 1 and typ not in PER_UNIT:
                desc = f'{left} x {desc}'[:150]
                remark.append(f'One asset for the batch of {left}.')
                asset_units = 1
            plan.append(dict(base, action='new', units=asset_units, unit_cost=round(r['unit_cost'] * left, 2),
                             how='not in the software' + (' (found in the laptop sheet)' if l else ''),
                             description=desc or typ, model=model, serial=serial if left == 1 else '',
                             configuration=(l and rec.config_of(l)) or '', manufacturer=brand_of(r['name'], model) or '',
                             status=status, condition=cond, location_code=location_code(r) or '', holder=holder or '',
                             note=' '.join(remark)))
            notes['new rows'] += 1
            notes['new assets'] += asset_units

    cols = ['action', 'asset_codes', 'units', 'register_row', 'item', 'unit_cost', 'purchase_date', 'capitalised', 'bill', 'party',
            'register_location', 'register_custodian', 'team', 'category', 'subcategory', 'description', 'manufacturer', 'model',
            'serial', 'configuration', 'status', 'condition', 'location_code', 'holder', 'how', 'note']
    with open(OUT, 'w', encoding='utf-8-sig', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore'); w.writeheader()
        for p in plan: w.writerow({c: p.get(c, '') for c in cols})
    for k, v in sorted(notes.items()): print(f'{k:<40} {v}')
    print('types of new assets:', dict(Counter((p['category'], p['subcategory']) for p in plan if p['action'] == 'new' for _ in range(int(p['units'])))))
    print('locations used:', dict(Counter(p['location_code'] or '(none)' for p in plan if p['action'] == 'new')))
    print('holders matched:', sum(1 for p in plan if p.get('holder')))
    print('written', OUT)

if __name__ == '__main__':
    main()
