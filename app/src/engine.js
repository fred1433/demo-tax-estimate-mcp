// Stand-in federal tax engine for the demo. Small on purpose: it is the module FileTax.com
// would replace with its own engine. Deterministic, no I/O. It either returns a full
// line-by-line estimate or refuses with stated reasons; it never guesses a missing input.
import { ENGINE, YEARS, LIMITS, OTHER_SITUATIONS, SOURCES } from './params.js';

export const FILING_STATUSES = ['single', 'married_filing_jointly', 'head_of_household', 'married_filing_separately', 'qualifying_surviving_spouse'];
const SUPPORTED_STATUSES = new Set(['single', 'married_filing_jointly', 'head_of_household']);

const STATUS_LABEL = {
  single: 'Single',
  married_filing_jointly: 'Married filing jointly',
  head_of_household: 'Head of household',
  married_filing_separately: 'Married filing separately',
  qualifying_surviving_spouse: 'Qualifying surviving spouse',
};

const fmt = (n) => '$' + Math.abs(n).toLocaleString('en-US');

// Tax from the rate schedule, in cents, exact (no rounding).
function scheduleTaxCents(brackets, incomeCents) {
  let tax = 0; // in cents * 10000 (rate in basis points)
  let lower = 0;
  for (const [upper, bp] of brackets) {
    const upperCents = upper === Infinity ? Infinity : upper * 100;
    if (incomeCents <= lower) break;
    const slice = Math.min(incomeCents, upperCents) - lower;
    tax += slice * bp;
    lower = upperCents;
  }
  return tax / 10000; // cents, may carry a fraction
}

// Round half up to the dollar, from cents.
const roundCentsToDollar = (cents) => Math.floor((cents + 50) / 100);

// IRS Tax Table (taxable income under $100,000). The table lists rows of $25 below $3,000 and
// $50 from $3,000; each row's tax is the rate schedule applied to the row midpoint, rounded.
// The first three rows (0-5, 5-15, 15-25) are special-cased by the table itself.
export function taxTable(year, status, taxableIncome) {
  const brackets = YEARS[year].brackets[status];
  if (taxableIncome < 5) return { tax: 0, row: [0, 5] };
  if (taxableIncome < 15) return { tax: roundCentsToDollar(scheduleTaxCents(brackets, 1000)), row: [5, 15] };
  if (taxableIncome < 25) return { tax: roundCentsToDollar(scheduleTaxCents(brackets, 2000)), row: [15, 25] };
  const width = taxableIncome < 3000 ? 25 : 50;
  const low = Math.floor(taxableIncome / width) * width;
  const midCents = low * 100 + (width * 100) / 2;
  return { tax: roundCentsToDollar(scheduleTaxCents(brackets, midCents)), row: [low, low + width] };
}

// Tax Computation Worksheet (taxable income of $100,000 or more), using the rows as printed.
export function taxWorksheet(year, status, taxableIncome) {
  const rows = YEARS[year].worksheet[status];
  for (const [upper, bp, subtractCents] of rows) {
    if (taxableIncome <= upper) {
      const cents = (taxableIncome * 100 * bp) / 10000 - subtractCents;
      return { tax: roundCentsToDollar(cents), rate_bp: bp, subtraction_cents: subtractCents };
    }
  }
  throw new Error('worksheet row not found');
}

export function line16Tax(year, status, taxableIncome) {
  if (taxableIncome < 100000) {
    const t = taxTable(year, status, taxableIncome);
    return { tax: t.tax, method: 'tax_table', detail: `Tax Table row $${t.row[0].toLocaleString('en-US')} to $${t.row[1].toLocaleString('en-US')}` };
  }
  const w = taxWorksheet(year, status, taxableIncome);
  return {
    tax: w.tax,
    method: 'tax_computation_worksheet',
    detail: `Tax Computation Worksheet: ${(w.rate_bp / 100).toFixed(0)}% of taxable income minus $${(w.subtraction_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
  };
}

function reason(code, message) {
  return { code, message };
}

// Validate the profile and collect every reason it is out of scope. Unknown or missing
// answers are reasons too: a missing answer never becomes "no".
export function scopeCheck(p) {
  const reasons = [];
  const year = p.tax_year ?? 2026;
  if (!YEARS[year]) reasons.push(reason('unsupported_tax_year', 'Only tax years 2026 and 2025 are covered.'));
  if (!SUPPORTED_STATUSES.has(p.filing_status)) {
    reasons.push(reason('unsupported_filing_status', `${STATUS_LABEL[p.filing_status] ?? 'This filing status'} is not covered by this stand-in engine. Covered: single, married filing jointly, head of household.`));
  }
  if (p.filing_status === 'head_of_household' && p.head_of_household_confirmed !== true) {
    reasons.push(reason('head_of_household_not_confirmed', 'Head of household needs a confirmation that you are unmarried (or considered unmarried), paid more than half the cost of keeping up a home, and a qualifying person lived with you. This tool does not infer it from having a child.'));
  }
  const isJoint = p.filing_status === 'married_filing_jointly';
  if (typeof p.taxpayer_age_65_or_older !== 'boolean') reasons.push(reason('missing_answer', 'Answer whether you will be 65 or older at the end of the year.'));
  if (typeof p.taxpayer_blind !== 'boolean') reasons.push(reason('missing_answer', 'Answer whether you are blind for tax purposes.'));
  if (typeof p.can_be_claimed_as_dependent !== 'boolean') reasons.push(reason('missing_answer', 'Answer whether someone else can claim you as a dependent.'));
  if (isJoint) {
    if (typeof p.spouse_age_65_or_older !== 'boolean') reasons.push(reason('missing_answer', 'Answer whether your spouse will be 65 or older at the end of the year.'));
    if (typeof p.spouse_blind !== 'boolean') reasons.push(reason('missing_answer', 'Answer whether your spouse is blind for tax purposes.'));
  }
  if (p.taxpayer_age_65_or_older === true || (isJoint && p.spouse_age_65_or_older === true)) {
    reasons.push(reason('age_65_or_older', 'Filers 65 or older get an additional standard deduction and may qualify for the senior deduction on Schedule 1-A. This stand-in engine does not compute them yet.'));
  }
  if (p.taxpayer_blind === true || (isJoint && p.spouse_blind === true)) {
    reasons.push(reason('blind', 'The additional standard deduction for blindness is not computed by this stand-in engine.'));
  }
  if (p.can_be_claimed_as_dependent === true) {
    reasons.push(reason('claimed_as_dependent', 'A filer who can be claimed as a dependent has a limited standard deduction. Not computed here.'));
  }
  if (!Number.isInteger(p.w2_wages) || p.w2_wages < 0) reasons.push(reason('missing_answer', 'Give the expected W-2 wages for the full year, in whole dollars.'));
  if (!Number.isInteger(p.federal_income_tax_withheld) || p.federal_income_tax_withheld < 0) reasons.push(reason('missing_answer', 'Give the expected federal income tax withheld for the full year, in whole dollars.'));
  if (Number.isInteger(p.w2_wages) && Number.isInteger(p.federal_income_tax_withheld) && p.federal_income_tax_withheld > p.w2_wages) {
    reasons.push(reason('withholding_above_wages', `${fmt(p.federal_income_tax_withheld)} of federal tax withheld is more than the ${fmt(p.w2_wages)} of W-2 wages, which cannot happen on a W-2. Check both full-year amounts.`));
  }
  if (Number.isInteger(p.w2_wages) && p.w2_wages > LIMITS.max_wages) {
    reasons.push(reason('wages_above_limit', `Wages above ${fmt(LIMITS.max_wages)} bring in Additional Medicare Tax and credit phase-outs this stand-in engine does not handle.`));
  }
  const kids = p.qualifying_children_under_17;
  if (!Number.isInteger(kids) || kids < 0) reasons.push(reason('missing_answer', 'Give the number of qualifying children under 17 (0 if none).'));
  if (Number.isInteger(kids) && kids > LIMITS.max_qualifying_children) {
    reasons.push(reason('three_or_more_children', 'Three or more qualifying children use Schedule 8812 Part II-B, which this stand-in engine does not compute.'));
  }
  if (Number.isInteger(kids) && kids > 0 && p.children_meet_ctc_rules !== true) {
    reasons.push(reason('child_rules_not_confirmed', 'The child tax credit needs a confirmation that each child is under 17 at year end, lived with you more than half the year, is your dependent, and has an SSN valid for employment, and that you (or one spouse on a joint return) have a valid SSN.'));
  }
  if (!Number.isInteger(p.other_dependents) || p.other_dependents < 0) reasons.push(reason('missing_answer', 'Give the number of other dependents (0 if none).'));
  if (Number.isInteger(p.other_dependents) && p.other_dependents > 0) {
    reasons.push(reason('other_dependents', 'Other dependents (credit for other dependents, $500 each) are not computed by this stand-in engine.'));
  }
  const other = Array.isArray(p.other_situations) ? p.other_situations : null;
  if (!other || other.length === 0) {
    reasons.push(reason('missing_answer', 'Confirm whether any other income, deduction or credit applies (or answer "none").'));
  } else {
    for (const s of other) {
      if (s === 'none') continue;
      reasons.push(reason(`situation_${s in OTHER_SITUATIONS ? s : 'other'}`, `${OTHER_SITUATIONS[s] ?? 'This situation'}: not handled by this stand-in engine.`));
    }
    if (other.includes('none') && other.length > 1) reasons.push(reason('contradictory_answer', '"None" was given together with other situations.'));
  }
  // Earned Income Credit: refused rather than ignored.
  if (reasons.length === 0) {
    const limits = YEARS[year].eic_completed_phaseout[isJoint ? 'married_filing_jointly' : 'other'];
    const limit = limits[Math.min(kids, 3)];
    if (p.w2_wages < limit) {
      reasons.push(reason('eic_may_apply', `With ${fmt(p.w2_wages)} of wages and ${kids} qualifying child${kids === 1 ? '' : 'ren'}, the Earned Income Credit may apply (it phases out completely at ${fmt(limit)} for ${year}). This stand-in engine does not compute it, so it gives no estimate rather than a wrong one.`));
    }
  }
  return reasons;
}

// Full estimate. Pure function of the profile.
export function estimate(profile) {
  const p = { tax_year: 2026, ...profile };
  const year = p.tax_year;
  const reasons = scopeCheck(p);
  const base = { engine: ENGINE, tax_year: year };
  if (reasons.length) {
    return { status: 'unsupported_scenario', ...base, reasons };
  }
  const Y = YEARS[year];
  const st = p.filing_status;
  const wages = p.w2_wages;
  const withheld = p.federal_income_tax_withheld;
  const kids = p.qualifying_children_under_17;

  const agi = wages; // line 11a: W-2 wages are the only income in scope
  const standardDeduction = Y.standard_deduction[st]; // line 12e
  const taxableIncome = Math.max(0, agi - standardDeduction); // line 15
  const l16 = line16Tax(year, st, taxableIncome); // line 16
  const taxBeforeCredits = l16.tax; // line 18 (no Schedule 2 items in scope)

  // Schedule 8812, Part I
  const s8812_l5 = kids * Y.ctc_per_child;
  const s8812_l8 = s8812_l5; // no other dependents in scope
  const over = Math.max(0, agi - Y.ctc_phaseout_start[st]);
  const s8812_l10 = over > 0 ? Math.ceil(over / 1000) * 1000 : 0;
  const s8812_l11 = Math.round(s8812_l10 * 0.05);
  const s8812_l12 = Math.max(0, s8812_l8 - s8812_l11);
  const creditLimit = taxBeforeCredits; // Credit Limit Worksheet A: line 18, no other credits in scope
  const ctc = Math.min(s8812_l12, creditLimit); // line 19
  // Schedule 8812, Part II-A (one or two children only)
  let actc = 0;
  const s8812_l16a = s8812_l12 - ctc;
  if (s8812_l16a > 0 && kids > 0) {
    const l16b = kids * Y.actc_per_child;
    const l17 = Math.min(s8812_l16a, l16b);
    const l19 = Math.max(0, wages - Y.actc_earned_income_floor);
    const l20 = roundCentsToDollar((l19 * Y.actc_rate_bp) / 100); // 15% of line 19, rounded to the dollar
    actc = Math.min(l17, l20); // line 27, then Form 1040 line 28
  }
  const totalTax = taxBeforeCredits - ctc; // line 24
  const totalPayments = withheld + actc; // line 33
  const diff = totalPayments - totalTax;
  const outcome = diff > 0 ? 'refund' : diff < 0 ? 'amount_owed' : 'zero';

  const assumptions = [
    `Tax year ${year}, filing status ${STATUS_LABEL[st].toLowerCase()}${st === 'head_of_household' ? ' (qualification confirmed by you, not checked by this tool)' : ''}.`,
    `${fmt(wages)} of expected W-2 wages for the full year is the only income; no adjustments, so adjusted gross income is ${fmt(agi)}.`,
    `${fmt(withheld)} of expected federal income tax withheld for the full year (W-2 box 2, not Social Security or Medicare).`,
    `Standard deduction of ${fmt(standardDeduction)}; nobody is 65 or older or blind, and nobody can claim you as a dependent.`,
    kids > 0
      ? `${kids} qualifying child${kids === 1 ? '' : 'ren'} under 17 meeting the child tax credit rules, as you confirmed.`
      : 'No qualifying children and no other dependents.',
    `${l16.detail}.`,
    'No other income, deduction or credit applies, as you confirmed. Earned Income Credit checked: income is above its limit.',
  ];
  if (st === 'single' && kids > 0) {
    assumptions.push('You chose single. If you paid more than half the cost of keeping up a home for a qualifying person, head of household may apply; this tool does not decide that.');
  }

  return {
    status: 'estimated',
    ...base,
    parameters_status: Y.status,
    parameters_note: Y.status_note,
    filing_status: st,
    outcome,
    amount: Math.abs(diff),
    lines: {
      wages_1a: wages,
      adjusted_gross_income_11a: agi,
      standard_deduction_12e: standardDeduction,
      taxable_income_15: taxableIncome,
      tax_16: taxBeforeCredits,
      tax_method: l16.method,
      child_tax_credit_19: ctc,
      total_tax_24: totalTax,
      federal_withholding_25d: withheld,
      additional_child_tax_credit_28: actc,
      total_payments_33: totalPayments,
    },
    assumptions,
    sources: Y.sources.map((id) => SOURCES[id]),
  };
}
