#!/usr/bin/env python3
"""Derive the expected results of the test profiles from IRS publications, independently of
the engine (different language, table lookup instead of a formula, worksheet rows read from
the PDF text).

Steps:
1. Download the IRS PDFs (URLs and SHA-256 below) into reference/pdf/ if missing.
2. pdftotext -layout each one, parse the Tax Table rows and the Tax Computation Worksheet rows.
3. Write reference/irs_tax_table_<year>.csv (every row: low, high, single, mfj, mfs, hoh).
4. For each profile in tests/fixtures/profiles.json, follow Form 1040 (2025 line numbers) and
   Schedule 8812 Part I and II-A by hand, write tests/fixtures/expected.json.

Run: python3 reference/derive_expected.py   (needs pdftotext from poppler)
"""
import csv, hashlib, json, math, os, re, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(ROOT, 'reference', 'pdf')
DOCS = {
    2026: {'url': 'https://www.irs.gov/pub/irs-dft/p1040--dft.pdf', 'file': 'p1040_2026_draft_2026-08-28.pdf',
           'label': 'Publication 1040 (2026), IRS draft dated Aug 28, 2026', 'worksheet_title': '2026 Tax Computation Worksheet'},
    2025: {'url': 'https://www.irs.gov/pub/irs-pdf/p1040.pdf', 'file': 'p1040_2025.pdf',
           'label': 'Publication 1040 (2025)', 'worksheet_title': '2025 Tax Computation Worksheet'},
}
# Typed in from the IRS documents (not imported from the engine):
STD = {  # Rev. Proc. 2025-32 sec. 4.14(1); 2025 Instructions for Form 1040 (standard deduction chart)
    2026: {'single': 16100, 'married_filing_jointly': 32200, 'head_of_household': 24150},
    2025: {'single': 15750, 'married_filing_jointly': 31500, 'head_of_household': 23625},
}
CTC = {2026: (2200, 1700), 2025: (2200, 1700)}  # Rev. Proc. 2025-32 sec. 4.05; 2025 Schedule 8812 lines 5 and 16b
COL = {'single': 2, 'married_filing_jointly': 3, 'head_of_household': 5}
WS_SECTION = {'single': 'Section A', 'married_filing_jointly': 'Section B', 'head_of_household': 'Section D'}


def fetch(year):
    os.makedirs(PDF_DIR, exist_ok=True)
    path = os.path.join(PDF_DIR, DOCS[year]['file'])
    if not os.path.exists(path):
        req = urllib.request.Request(DOCS[year]['url'], headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as r, open(path, 'wb') as f:
            f.write(r.read())
    sha = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    txt = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True, check=True).stdout
    return txt, sha


def num(s):
    return int(s.replace(',', ''))


def parse_tax_table(txt, year):
    # The Tax Table pages come before the worksheet title.
    end = txt.index(DOCS[year]['worksheet_title'] + '—Line 16')
    rows = {}
    for line in txt[:end].splitlines():
        nums = [num(x) for x in re.findall(r'(?<![\d,])\d{1,3}(?:,\d{3})*(?![\d,])', line)]
        i = 0
        while i + 5 < len(nums):
            low, high = nums[i], nums[i + 1]
            if high - low in (5, 10, 25, 50) and low % 5 == 0:
                taxes = nums[i + 2:i + 6]
                rows[low] = (low, high, *taxes)
                i += 6
            else:
                i += 1
    return [rows[k] for k in sorted(rows)]


def parse_worksheet(txt, year):
    start = txt.index(DOCS[year]['worksheet_title'] + '—Line 16')
    block = txt[start:start + 12000]
    out = {}
    for status, sec in WS_SECTION.items():
        s = block.index(sec)
        nxt = min([block.index(x, s + 5) for x in ('Section A', 'Section B', 'Section C', 'Section D', 'Earned Income Credit') if x in block[s + 5:]] or [len(block)])
        rows = []
        for line in block[s:nxt].splitlines():
            m = re.search(r'(At least \$100,000 but not over \$([\d,]+)|Over \$([\d,]+) but not over \$([\d,]+)|Over \$([\d,]+)\s)\s.*?(\d+)% \(0\.\d+\).*?\$\s*([\d,]+\.\d\d)', line)
            if not m:
                continue
            if m.group(2):
                lo, hi = 100000, num(m.group(2))
            elif m.group(3):
                lo, hi = num(m.group(3)), num(m.group(4))
            else:
                lo, hi = num(m.group(5)), None
            rows.append({'over': lo, 'not_over': hi, 'rate_pct': int(m.group(6)), 'subtract': m.group(7).replace(',', '')})
        out[status] = rows
    return out


def lookup_table(table, ti, status):
    for r in table:
        if r[0] <= ti < r[1]:
            return r[COL[status]], f'Tax Table row {r[0]:,} to {r[1]:,}'
    raise ValueError(f'no table row for {ti}')


def worksheet_tax(ws, ti, status):
    from decimal import Decimal, ROUND_HALF_UP
    for r in ws[status]:
        if (r['not_over'] is None and ti > r['over']) or (r['not_over'] is not None and ti <= r['not_over'] and ti >= r['over']):
            v = Decimal(ti) * Decimal(r['rate_pct']) / Decimal(100) - Decimal(r['subtract'])
            return int(v.quantize(Decimal('1'), rounding=ROUND_HALF_UP)), f"Worksheet: {r['rate_pct']}% x {ti:,} minus {r['subtract']}"
    raise ValueError('no worksheet row')


def derive(p, tables, worksheets):
    y, st = p['tax_year'], p['filing_status']
    wages, withheld, kids = p['w2_wages'], p['federal_income_tax_withheld'], p['qualifying_children_under_17']
    l11 = wages
    l12e = STD[y][st]
    l15 = max(0, l11 - l12e)
    if l15 < 100000:
        l16, how = lookup_table(tables[y], l15, st)
    else:
        l16, how = worksheet_tax(worksheets[y], l15, st)
    l18 = l16
    per_child, per_child_refundable = CTC[y]
    s5 = kids * per_child
    s9 = 400000 if st == 'married_filing_jointly' else 200000
    s10 = max(0, l11 - s9)
    s10 = int(math.ceil(s10 / 1000.0) * 1000) if s10 else 0
    s11 = s10 * 5 // 100
    s12 = max(0, s5 - s11)
    s13 = l18  # Credit Limit Worksheet A with no other credits
    s14 = min(s12, s13)
    actc = 0
    s16a = s12 - s14
    if s16a > 0:
        s16b = kids * per_child_refundable
        s17 = min(s16a, s16b)
        s19 = max(0, wages - 2500)
        s20 = (s19 * 15 + 50) // 100  # 15%, rounded half up to the dollar
        actc = min(s17, s20)
    l24 = l18 - s14
    l33 = withheld + actc
    diff = l33 - l24
    return {
        'tax_year': y, 'method': how, 'adjusted_gross_income_11a': l11, 'standard_deduction_12e': l12e,
        'taxable_income_15': l15, 'tax_16': l16, 'child_tax_credit_19': s14, 'total_tax_24': l24,
        'federal_withholding_25d': withheld, 'additional_child_tax_credit_28': actc, 'total_payments_33': l33,
        'outcome': 'refund' if diff > 0 else ('amount_owed' if diff < 0 else 'zero'), 'amount': abs(diff),
    }


def main():
    tables, worksheets, provenance = {}, {}, {}
    for y in DOCS:
        txt, sha = fetch(y)
        t = parse_tax_table(txt, y)
        if len(t) < 1900:
            sys.exit(f'{y}: only {len(t)} Tax Table rows parsed')
        tables[y] = t
        worksheets[y] = parse_worksheet(txt, y)
        for st in WS_SECTION:
            if len(worksheets[y][st]) < 5:
                sys.exit(f'{y} {st}: worksheet rows not parsed')
        with open(os.path.join(ROOT, 'reference', f'irs_tax_table_{y}.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['at_least', 'but_less_than', 'single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household'])
            w.writerows(t)
        provenance[y] = {'document': DOCS[y]['label'], 'url': DOCS[y]['url'], 'sha256': sha, 'tax_table_rows': len(t), 'worksheet': worksheets[y]}
    fx = json.load(open(os.path.join(ROOT, 'tests', 'fixtures', 'profiles.json')))
    expected = {}
    for p in fx['profiles']:
        full = {**fx['common'], **(fx['joint_extra'] if p['filing_status'] == 'married_filing_jointly' else {}), **p}
        expected[p['id']] = derive(full, tables, worksheets)
    out = {'generated_by': 'reference/derive_expected.py', 'provenance': provenance, 'expected': expected}
    json.dump(out, open(os.path.join(ROOT, 'tests', 'fixtures', 'expected.json'), 'w'), indent=2)
    for k, v in expected.items():
        print(k, v['tax_year'], v['taxable_income_15'], v['tax_16'], v['child_tax_credit_19'], v['additional_child_tax_credit_28'], v['outcome'], v['amount'], '|', v['method'])


if __name__ == '__main__':
    main()
