"""IT reconciliation: production assets vs the finance fixed asset register vs IT's laptop sheet.

Usage:
  python -I "import sql/it-reconcile.py" <prod-it.csv> <Fixed asset 26-27 Mini.xlsx> <PO workbook.xlsx>

Read-only. Writes it-reconcile-review.xlsx next to this script with:
  Summary              counts
  In software          every live production asset, the register row and laptop-sheet row it
                       matched, blanks the sources can fill, and values that disagree
  Register not in sw   finance register IT rows with no asset in the software (to add)
  Laptop sheet not in sw  laptop-sheet rows found nowhere in the software (to add or check)

Only the "Laptop Details" sheet of the PO workbook is read (never the password or email sheets).
"""
import csv, datetime, importlib.util, os, re, sys
from collections import defaultdict

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'it-reconcile-review.xlsx')

spec = importlib.util.spec_from_file_location('far', os.path.join(HERE, 'generate-far-import.py'))
far = importlib.util.module_from_spec(spec)
spec.loader.exec_module(far)


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def serials(v):
    """Every serial-looking token in a cell ("SPF3ZK4PK /\\nPF3ZK4PK" gives both)."""
    out = set()
    v = re.sub(r'(?i)\bs\s*/\s*n\s*[.:]?\s*', ' ', str(v or ''))   # "S/N.TIPL..." → "TIPL..."
    for part in re.split(r'[\s/,;]+|-\s', v):
        p = norm(part)
        if len(p) >= 6 and re.search(r'\d', p) and re.search(r'[a-z]', p) and not p.startswith('imei'):
            out.add(p)
    whole = norm(v)
    if 6 <= len(whole) <= 20 and re.search(r'\d', whole): out.add(whole)
    return out


def same_serial(a, b):
    # Lenovo labels add a leading S (SPF3NY3H2 = PF3NY3H2).
    return a == b or a == 's' + b or b == 's' + a


def any_serial(xs, ys):
    return any(same_serial(x, y) for x in xs for y in ys)


def to_date(v):
    if isinstance(v, datetime.datetime): return v.date()
    if isinstance(v, datetime.date): return v
    if isinstance(v, str):
        for fmt in ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y', '%d-%m-%y', '%d.%m.%Y'):
            try: return datetime.datetime.strptime(v.strip(), fmt).date()
            except ValueError: pass
    return None


def money(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool): return float(v)
    if isinstance(v, str):
        try: return float(v.replace(',', ''))
        except ValueError: return None
    return None


def close(a, b, tol=1.0):
    return a is not None and b is not None and abs(a - b) <= tol


def days_apart(a, b):
    return abs((a - b).days) if a and b else 9999


# ------------------------------------------------------------------------------------------
# Sources

def load_prod(path):
    rows = list(csv.DictReader(open(path, encoding='utf-8-sig')))
    for r in rows:
        r['cost'] = money(r['purchase_cost']) if r['purchase_cost'] else None
        r['date'] = to_date(r['purchase_date']) if r['purchase_date'] else None
        r['serials'] = serials(r['serial_number'])
    return rows


def load_register(path):
    out = []
    for r in far.load(path):
        cat, typ, team = far.classify(r)
        if team != far.IT: continue
        qty = int(r['qty']) if r['qty'] and r['qty'] >= 1 else 1
        r.update(category=cat, type=typ, units=qty, unit_cost=round(r['cost'] / qty, 2),
                 serials=serials(r['serial']) | serials(r['model']))
        out.append(r)
    return out


LAPTOP_TYPES = {
    'notebook': 'Laptop', 'apple macbook': 'Laptop', 'desktop': 'Desktop', 'tablet': 'Tablet',
    'external hdd': 'External Storage', 'external ssd': 'External Storage', 'laptop adaptor': 'Charger & Adapter',
    'mobile': 'Mobile Phone', 'bio metric': 'Biometric Device', 'paper shredder': 'Shredder',
}


def ld_type(r):
    t = (r['type'] or '').lower()
    if t in LAPTOP_TYPES: return LAPTOP_TYPES[t]
    if 'cctv' in t or 'cctv' in (r['user'] or '').lower(): return 'CCTV Camera'
    if 'nvr' in t or 'nvr' in (r['user'] or '').lower(): return 'NVR / DVR'
    if 'printer' in t: return 'Printer'
    if 'biometric' in (r['user'] or '').lower(): return 'Biometric Device'
    if 'wire' in t: return 'Networking'
    if 'firewall' in (r['user'] or '').lower(): return 'Networking'
    return r['type'] or ''


def load_laptops(path):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)['Laptop Details']
    rows = [list(r) + [None] * 25 for r in ws.iter_rows(values_only=True)]
    head = [norm(str(h)) for h in rows[0]]
    c = {k: head.index(v) for k, v in {
        'sl': 'slno', 'user': 'username', 'current': 'currentusers', 'vendor': 'vendername',
        'amount': 'amount', 'date': 'purchasedate', 'note': 'assetno', 'type': 'assesttype',
        'model': 'laptopmodel', 'cpu': 'processor', 'ram': 'ram', 'serial': 'systemserialno',
        'os': 'os', 'disk_type': 'storagetype', 'disk': 'storagesize', 'gpu': 'graphicsname',
        'gpu_mem': 'graphicsghz', 'cost': 'cost', 'site': 'company'}.items()}
    out = []
    for n, r in enumerate(rows[1:], start=2):
        get = lambda k: (str(r[c[k]]).strip() if isinstance(r[c[k]], str) else r[c[k]])
        if not any(get(k) for k in ('user', 'model', 'serial', 'amount')): continue
        if isinstance(get('note'), str) and get('note').lower() == 'no system': continue
        item = {k: get(k) for k in c}
        item['row'] = n
        item['price'] = money(item['amount']) or money(item['cost'])
        item['when'] = to_date(item['date'])
        item['serials'] = serials(item['serial']) if item['serial'] not in ('-', None) else set()
        item['kind'] = ld_type(item)
        out.append(item)
    return out


def config_of(l):
    parts = [l.get('cpu'), l.get('ram') and f"{l['ram']} RAM",
             l.get('disk') and f"{l['disk']} {l.get('disk_type') or ''}".strip(), l.get('os')]
    return ', '.join(str(p).strip() for p in parts if p and str(p).strip() not in ('N/A', '-'))


def graphics_of(l):
    parts = [l.get('gpu'), l.get('gpu_mem')]
    return ', '.join(str(p).strip() for p in parts if p and str(p).strip() not in ('N/A', '-'))


# ------------------------------------------------------------------------------------------
# Matching

def match(prod, reg, lap):
    lap_of, reg_of = {}, {}           # prod id → laptop row / register row
    lap_used, reg_left = set(), {r['row']: r['units'] for r in reg}

    # 1. Laptop sheet ↔ production by serial.
    for p in prod:
        if not p['serials']: continue
        for l in lap:
            if l['row'] in lap_used or not l['serials']: continue
            if any_serial(p['serials'], l['serials']):
                lap_of[p['id']] = l; lap_used.add(l['row']); break

    def take(p, r, how):
        reg_of[p['id']] = (r, how); reg_left[r['row']] -= 1

    def free(r): return reg_left[r['row']] > 0

    # 2. Register ↔ production: serial, then bill + cost, then purchase date + cost.
    for p in prod:
        for r in reg:
            if free(r) and r['serials'] and p['serials'] and any_serial(p['serials'], r['serials']):
                take(p, r, 'serial'); break
    for p in prod:
        if p['id'] in reg_of or not p['invoice_number']: continue
        for r in reg:
            if free(r) and r['bill'] and norm(r['bill']) == norm(p['invoice_number']) and (
                    p['cost'] is None or close(p['cost'], r['unit_cost'], 2)):
                take(p, r, 'bill'); break
    for p in prod:
        if p['id'] in reg_of or p['cost'] is None: continue
        for r in reg:
            if free(r) and close(p['cost'], r['unit_cost'], 2) and days_apart(p['date'], r['dop']) <= 3:
                take(p, r, 'date + cost'); break
    # 3. Through the laptop sheet: its price and date to the register.
    for p in prod:
        l = lap_of.get(p['id'])
        if p['id'] in reg_of or not l or l['price'] is None: continue
        for r in reg:
            if free(r) and close(l['price'], r['unit_cost'], 2) and days_apart(l['when'], r['dop']) <= 10:
                take(p, r, 'laptop sheet date + cost'); break
    # 4. Cost alone, same kind, nearest date (weakest; flagged for checking).
    for p in prod:
        if p['id'] in reg_of or p['cost'] is None: continue
        best = None
        for r in reg:
            if free(r) and close(p['cost'], r['unit_cost'], 2) and r['type'] == p['asset_type']:
                d = days_apart(p['date'], r['dop'])
                if best is None or d < best[0]: best = (d, r)
        if best and best[0] <= 120: take(p, best[1], f'cost only, {best[0]} days apart - check')

    # 5. Leftover laptop rows ↔ leftover register rows (things missing from the software).
    reg_lap = {}
    for l in lap:
        if l['row'] in lap_used: continue
        for r in reg:
            if free(r) and ((l['serials'] and r['serials'] and any_serial(l['serials'], r['serials']))
                            or (close(l['price'], r['unit_cost'], 2) and days_apart(l['when'], r['dop']) <= 10)):
                reg_lap.setdefault(r['row'], []).append(l); lap_used.add(l['row']); reg_left[r['row']] -= 1
                break
    return lap_of, reg_of, reg_left, reg_lap, lap_used


# ------------------------------------------------------------------------------------------
# Output

def sheet(wb, title, header, rows, widths=None):
    ws = wb.create_sheet(title)
    ws.append(header)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='1F3A68')
    for r in rows: ws.append([('' if v is None else v) for v in r])
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = ws.dimensions
    for i, h in enumerate(header, start=1):
        ws.column_dimensions[get_column_letter(i)].width = (widths or {}).get(h, min(max(len(h) + 2, 12), 40))
    return ws


def main():
    prod = load_prod(sys.argv[1])
    reg = load_register(sys.argv[2])
    lap = load_laptops(sys.argv[3])
    lap_of, reg_of, reg_left, reg_lap, lap_used = match(prod, reg, lap)

    in_sw = []
    fills = defaultdict(int)
    for p in prod:
        l = lap_of.get(p['id'])
        r, how = reg_of.get(p['id'], (None, ''))
        fill, differ = [], []
        def want(field, label, value, current):
            if value in (None, '') or str(value).strip() in ('-', 'N/A'): return
            if not current:
                fill.append(f'{label}: {value}'); fills[label] += 1
            elif label in ('Cost', 'Purchase date') and str(value) != str(current):
                differ.append(f'{label}: software {current} / source {value}')
        if r:
            want('cost', 'Cost', r['unit_cost'], p['cost'])
            want('date', 'Purchase date', r['dop'], p['date'])
            want('bill', 'Invoice', r['bill'], p['invoice_number'])
            want('party', 'Supplier', r['party'], p['supplier'])
            want('cap', 'Capitalised', r['docap'], p['capitalisation_date'])
        if l:
            want('model', 'Model', l['model'], p['model'])
            want('config', 'Configuration', config_of(l), p['configuration'])
            if not r:
                want('cost', 'Cost', l['price'], p['cost'])
                want('date', 'Purchase date', l['when'], p['date'])
                want('party', 'Supplier', l['vendor'], p['supplier'])
        if r and p['cost'] is not None and not close(p['cost'], r['unit_cost'], 2):
            differ.append(f"Cost: software {p['cost']:.0f} / register {r['unit_cost']:.0f}")
        in_sw.append([
            p['asset_code'], p['asset_type'], p['description'], p['model'], p['serial_number'], p['holder'],
            p['status'], p['purchase_date'], p['cost'], p['invoice_number'],
            r and r['row'], r and r['name'], r and r['unit_cost'], r and r['dop'], r and r['bill'], r and r['party'],
            how, l and l['row'], l and l['model'], l and config_of(l),
            '; '.join(fill), '; '.join(differ),
            'Found in both' if r and l else 'Register only' if r else 'Laptop sheet only' if l else 'Not in either - check',
        ])

    missing_reg = []
    for r in reg:
        left = reg_left[r['row']]
        if left <= 0: continue
        ls = reg_lap.get(r['row'], [])
        l = ls[0] if ls else None
        missing_reg.append([
            r['row'], r['name'], r['category'], r['type'], left, r['units'], r['unit_cost'], r['cost'],
            r['dop'], r['docap'], r['bill'], r['party'], r['location'], r['custodian'], r['model'], r['serial'],
            l and l['row'], l and l['model'], l and l['serial'], l and config_of(l), l and (l['current'] or l['user']),
        ])

    missing_lap = []
    for l in lap:
        if l['row'] in lap_used: continue
        missing_lap.append([
            l['row'], l['kind'], l['type'], l['model'], l['serial'], l['user'], l['current'], l['vendor'],
            l['price'], l['when'], config_of(l), graphics_of(l), l['site'], l['note'],
        ])

    # Assets in the software sharing a serial (or one serial with extra characters on the end).
    dupes = []
    by_serial = defaultdict(list)
    for p in prod:
        for s in p['serials']:
            group = by_serial[s[1:] if s.startswith('s') and len(s) > 8 else s]
            if p not in group: group.append(p)
    seen = set()
    for s, ps in sorted(by_serial.items()):
        near = [q for q in prod if q not in ps and any(len(t) > len(s) and t.startswith(s) for t in q['serials'])]
        group = ps + near
        key = tuple(sorted(p['asset_code'] for p in group))
        if len(group) < 2 or key in seen: continue
        seen.add(key)
        for p in group:
            dupes.append([s.upper(), p['asset_code'], p['asset_type'], p['model'], p['serial_number'], p['holder'],
                          p['status'], p['purchase_date'], p['cost'],
                          'Same serial' if p in ps else 'Serial has extra characters - likely a typo'])

    wb = openpyxl.Workbook(); wb.remove(wb.active)
    status = defaultdict(int)
    for row in in_sw: status[row[-1]] += 1
    summary = [
        ['Live assets in the software (production copy)', len(prod)],
        ['  matched to the finance register and the laptop sheet', status['Found in both']],
        ['  matched to the finance register only', status['Register only']],
        ['  matched to the laptop sheet only', status['Laptop sheet only']],
        ['  in neither source (check these)', status['Not in either - check']],
        ['Finance register IT rows', len(reg)],
        ['  units in the register', sum(r['units'] for r in reg)],
        ['  units not found in the software (to add)', sum(max(v, 0) for v in reg_left.values())],
        ['Laptop sheet rows', len(lap)],
        ['  not found in the software or the register', len(missing_lap)],
        ['Assets in the software that look like duplicates', len(dupes)],
        ['Blanks in the software the sources can fill', ''],
    ] + [[f'  {k}', v] for k, v in sorted(fills.items())]
    sheet(wb, 'Summary', ['What', 'Count'], summary, {'What': 60, 'Count': 10})
    sheet(wb, 'In software', [
        'Asset ID', 'Subcategory', 'Description', 'Model', 'Serial', 'Held by', 'Status', 'Purchase date', 'Cost',
        'Invoice', 'Register row', 'Register item', 'Register cost', 'Register date', 'Register bill',
        'Register party', 'Matched by', 'Laptop sheet row', 'Laptop sheet model', 'Laptop sheet configuration',
        'Can fill', 'Disagrees', 'Result'], in_sw,
        {'Description': 30, 'Register item': 30, 'Can fill': 60, 'Disagrees': 45, 'Laptop sheet configuration': 45})
    sheet(wb, 'Register not in software', [
        'Register row', 'Item', 'Category', 'Subcategory', 'Units missing', 'Units in row', 'Unit cost',
        'Row cost', 'Purchase date', 'Capitalised', 'Bill', 'Party', 'Location', 'Custodian', 'Model', 'Serial',
        'Laptop sheet row', 'Laptop sheet model', 'Laptop sheet serial', 'Laptop sheet configuration',
        'Laptop sheet user'], missing_reg, {'Item': 35, 'Laptop sheet configuration': 45})
    sheet(wb, 'Laptop sheet not in software', [
        'Laptop sheet row', 'Kind', 'Type in sheet', 'Model', 'Serial', 'User', 'Current user', 'Vendor', 'Price',
        'Purchase date', 'Configuration', 'Graphics', 'Site', 'Note'], missing_lap, {'Configuration': 45})
    sheet(wb, 'Duplicates in software', [
        'Serial', 'Asset ID', 'Subcategory', 'Model', 'Serial in software', 'Held by', 'Status', 'Purchase date',
        'Cost', 'Why'], dupes, {'Why': 40})
    wb.save(OUT)
    for row in summary: print(f'{row[0]:<60} {row[1]}')
    print('written', OUT)


if __name__ == '__main__':
    main()
