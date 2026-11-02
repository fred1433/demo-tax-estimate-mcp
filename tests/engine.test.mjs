// Engine against the IRS reference: every Tax Table row of both years, the fourteen profiles
// derived by reference/derive_expected.py, and the refusal cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimate, taxTable, taxWorksheet } from '../app/src/engine.js';
import { YEARS } from '../app/src/params.js';

const root = new URL('../', import.meta.url);
const fx = JSON.parse(readFileSync(new URL('tests/fixtures/profiles.json', root)));
const expected = JSON.parse(readFileSync(new URL('tests/fixtures/expected.json', root))).expected;
const full = (p) => ({ ...fx.common, ...(p.filing_status === 'married_filing_jointly' ? fx.joint_extra : {}), ...p });

for (const year of [2025, 2026]) {
  test(`Tax Table ${year}: engine reproduces every IRS row for single, joint and head of household`, () => {
    const rows = readFileSync(new URL(`reference/irs_tax_table_${year}.csv`, root), 'utf8').trim().split('\n').slice(1);
    assert.ok(rows.length >= 2000, `rows: ${rows.length}`);
    let checked = 0;
    for (const line of rows) {
      const [low, high, single, mfj, , hoh] = line.split(',').map(Number);
      for (const [status, want] of [['single', single], ['married_filing_jointly', mfj], ['head_of_household', hoh]]) {
        for (const ti of [low, high - 1]) {
          assert.equal(taxTable(year, status, ti).tax, want, `${year} ${status} ${ti}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 12000);
  });

  test(`Tax Computation Worksheet ${year} agrees with the rate schedule at bracket edges`, () => {
    for (const status of ['single', 'married_filing_jointly', 'head_of_household']) {
      for (const [upper] of YEARS[year].worksheet[status]) {
        if (upper === Infinity) continue;
        // continuity: the tax at the top of one row equals the tax computed by the next row
        const a = taxWorksheet(year, status, upper).tax;
        const b = taxWorksheet(year, status, upper + 1).tax;
        assert.ok(b - a >= 0 && b - a <= 1, `${year} ${status} at ${upper}: ${a} then ${b}`);
      }
    }
  });
}

for (const p of fx.profiles) {
  test(`profile ${p.id} (${p.label}) equals the IRS-derived reference to the dollar`, () => {
    const r = estimate(full(p));
    const e = expected[p.id];
    assert.equal(r.status, 'estimated', JSON.stringify(r.reasons));
    for (const k of ['adjusted_gross_income_11a', 'standard_deduction_12e', 'taxable_income_15', 'tax_16', 'child_tax_credit_19', 'total_tax_24', 'federal_withholding_25d', 'additional_child_tax_credit_28', 'total_payments_33']) {
      assert.equal(r.lines[k], e[k], `${p.id} ${k}`);
    }
    assert.equal(r.outcome, e.outcome);
    assert.equal(r.amount, e.amount);
  });
}

for (const p of fx.refusals) {
  test(`refusal ${p.id}: ${p.expect}`, () => {
    const r = estimate(full(p));
    assert.equal(r.status, 'unsupported_scenario');
    assert.ok(r.reasons.some((x) => x.code === p.expect), JSON.stringify(r.reasons));
    assert.equal(r.amount, undefined);
  });
}

test('a missing answer is a refusal, never a zero', () => {
  const p = full(fx.profiles[0]);
  for (const k of ['taxpayer_age_65_or_older', 'can_be_claimed_as_dependent', 'other_situations', 'federal_income_tax_withheld', 'other_dependents']) {
    const q = { ...p };
    delete q[k];
    const r = estimate(q);
    assert.equal(r.status, 'unsupported_scenario', k);
    assert.ok(r.reasons.some((x) => x.code === 'missing_answer'), k);
  }
  const joint = full(fx.profiles[1]);
  delete joint.spouse_age_65_or_older;
  assert.equal(estimate(joint).status, 'unsupported_scenario');
});

test('"none" together with another situation is contradictory', () => {
  const r = estimate({ ...full(fx.profiles[0]), other_situations: ['none', 'overtime'] });
  assert.ok(r.reasons.some((x) => x.code === 'contradictory_answer'));
  assert.ok(r.reasons.some((x) => x.code === 'situation_overtime'));
});

test('single with a child stays single: head of household is never inferred', () => {
  const r = estimate(full(fx.profiles.find((x) => x.id === 'p06')));
  assert.equal(r.filing_status, 'single');
  assert.ok(r.assumptions.some((a) => a.includes('head of household may apply')));
});

test('2026 results carry the draft status of the IRS tables', () => {
  const r = estimate(full(fx.profiles[0]));
  assert.equal(r.parameters_status, 'draft');
  assert.match(r.parameters_note, /Aug 28, 2026/);
  assert.equal(estimate(full(fx.profiles.find((x) => x.tax_year === 2025))).parameters_status, 'final');
});
