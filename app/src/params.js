// Stand-in tax engine parameters. Every number below is copied from the IRS document named
// next to it. Amounts are whole dollars unless the name ends in _cents.
//
// 2026: Rev. Proc. 2025-32 (sections 4.01, 4.05, 4.06, 4.14) and the 2026 Publication 1040
//       draft dated Aug 28, 2026 (Tax Table and Tax Computation Worksheet). The 2026 tables are
//       an IRS draft: "DRAFT, NOT FOR FILING". They can still change.
// 2025: 2025 Instructions for Form 1040 (final), 2025 Publication 1040 (final, Tax Computation
//       Worksheet), 2025 Schedule 8812 and its instructions (final).

export const ENGINE = { name: 'stand-in-tax-engine', version: '0.3.0' };

export const SOURCES = {
  rp2532: {
    id: 'rp2532',
    title: 'Rev. Proc. 2025-32, section 4 (2026 inflation-adjusted items)',
    url: 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
  },
  p1040_2026_draft: {
    id: 'p1040_2026_draft',
    title: 'Publication 1040 (2026), Tax Table and Tax Computation Worksheet, IRS draft of Aug 28, 2026',
    url: 'https://www.irs.gov/pub/irs-dft/p1040--dft.pdf',
  },
  i1040_2025: {
    id: 'i1040_2025',
    title: '2025 Instructions for Form 1040 (standard deduction, line 16, EIC limits)',
    url: 'https://www.irs.gov/pub/irs-pdf/i1040gi.pdf',
  },
  p1040_2025: {
    id: 'p1040_2025',
    title: 'Publication 1040 (2025), Tax Table and Tax Computation Worksheet',
    url: 'https://www.irs.gov/pub/irs-pdf/p1040.pdf',
  },
  s8812_2025: {
    id: 's8812_2025',
    title: '2025 Schedule 8812 (Form 1040) and instructions',
    url: 'https://www.irs.gov/pub/irs-pdf/f1040s8.pdf',
  },
};

// Bracket tables: [upper bound of bracket in dollars (Infinity for the last), rate in basis points].
// The tax formula only serves to reproduce the Tax Table (midpoint rule) and to check the
// worksheet; the worksheet rows themselves are copied separately below.
const BRACKETS_2026 = {
  // Rev. Proc. 2025-32, section 4.01, Tables 1 to 3
  married_filing_jointly: [[24800, 1000], [100800, 1200], [211400, 2200], [403550, 2400], [512450, 3200], [768700, 3500], [Infinity, 3700]],
  head_of_household: [[17700, 1000], [67450, 1200], [105700, 2200], [201750, 2400], [256200, 3200], [640600, 3500], [Infinity, 3700]],
  single: [[12400, 1000], [50400, 1200], [105700, 2200], [201775, 2400], [256225, 3200], [640600, 3500], [Infinity, 3700]],
};
const BRACKETS_2025 = {
  // 2025 Publication 1040, Tax Computation Worksheet bracket edges (sections A, B, D)
  married_filing_jointly: [[23850, 1000], [96950, 1200], [206700, 2200], [394600, 2400], [501050, 3200], [751600, 3500], [Infinity, 3700]],
  head_of_household: [[17000, 1000], [64850, 1200], [103350, 2200], [197300, 2400], [250500, 3200], [626350, 3500], [Infinity, 3700]],
  single: [[11925, 1000], [48475, 1200], [103350, 2200], [197300, 2400], [250525, 3200], [626350, 3500], [Infinity, 3700]],
};

// Tax Computation Worksheet rows (taxable income of $100,000 or more), copied from the
// publication: [upper bound, multiplication rate in basis points, subtraction amount in cents].
const WORKSHEET_2026 = {
  // 2026 Publication 1040 draft, "2026 Tax Computation Worksheet, Line 16", sections A, B, D
  single: [[105700, 2200, 528800], [201775, 2400, 740200], [256225, 3200, 2354400], [640600, 3500, 3123075], [Infinity, 3700, 4404275]],
  married_filing_jointly: [[100800, 1200, 49600], [211400, 2200, 1057600], [403550, 2400, 1480400], [512450, 3200, 4708800], [768700, 3500, 6246150], [Infinity, 3700, 7783550]],
  head_of_household: [[105700, 2200, 709900], [201750, 2400, 921300], [256200, 3200, 2535300], [640600, 3500, 3303900], [Infinity, 3700, 4585100]],
};
const WORKSHEET_2025 = {
  // 2025 Publication 1040, "2025 Tax Computation Worksheet, Line 16", sections A, B, D
  single: [[103350, 2200, 508600], [197300, 2400, 715300], [250525, 3200, 2293700], [626350, 3500, 3045275], [Infinity, 3700, 4297975]],
  married_filing_jointly: [[206700, 2200, 1017200], [394600, 2400, 1430600], [501050, 3200, 4587400], [751600, 3500, 6090550], [Infinity, 3700, 7593750]],
  head_of_household: [[103350, 2200, 682500], [197300, 2400, 889200], [250500, 3200, 2467600], [626350, 3500, 3219100], [Infinity, 3700, 4471800]],
};

export const YEARS = {
  2026: {
    status: 'draft',
    status_note: 'Tax Table and worksheet from the IRS draft of Publication 1040 (2026) dated Aug 28, 2026. Drafts can still change before filing season.',
    sources: ['rp2532', 'p1040_2026_draft'],
    standard_deduction: { single: 16100, married_filing_jointly: 32200, head_of_household: 24150 }, // Rev. Proc. 2025-32, 4.14(1)
    brackets: BRACKETS_2026,
    worksheet: WORKSHEET_2026,
    ctc_per_child: 2200, // Rev. Proc. 2025-32, 4.05(1)
    actc_per_child: 1700, // Rev. Proc. 2025-32, 4.05(2)
    ctc_phaseout_start: { single: 200000, married_filing_jointly: 400000, head_of_household: 200000 }, // IRC 24(h)(3)
    actc_earned_income_floor: 2500, // IRC 24(h)(6)
    actc_rate_bp: 1500, // 15 percent, IRC 24(d)(1)(B)(i)
    // EIC completed phaseout amounts, Rev. Proc. 2025-32, 4.06(1): profiles below these are
    // refused because this engine does not compute the Earned Income Credit.
    eic_completed_phaseout: {
      married_filing_jointly: [26820, 58863, 65899, 70244],
      other: [19540, 51593, 58629, 62974],
    },
  },
  2025: {
    status: 'final',
    status_note: 'Final 2025 IRS instructions and Publication 1040 (2025).',
    sources: ['i1040_2025', 'p1040_2025', 's8812_2025'],
    standard_deduction: { single: 15750, married_filing_jointly: 31500, head_of_household: 23625 }, // 2025 Instructions for Form 1040
    brackets: BRACKETS_2025,
    worksheet: WORKSHEET_2025,
    ctc_per_child: 2200, // 2025 Schedule 8812, line 5
    actc_per_child: 1700, // 2025 Schedule 8812, line 16b
    ctc_phaseout_start: { single: 200000, married_filing_jointly: 400000, head_of_household: 200000 }, // 2025 Schedule 8812, line 9
    actc_earned_income_floor: 2500, // 2025 Schedule 8812, line 19
    actc_rate_bp: 1500, // 2025 Schedule 8812, line 20
    // EIC limits, 2025 Instructions for Form 1040, EIC Step 5 (earned income less than ...)
    eic_completed_phaseout: {
      married_filing_jointly: [26214, 57554, 64430, 68675],
      other: [19104, 50434, 57310, 61555],
    },
  },
};

// Scope of the stand-in engine. Anything outside is refused with a stated reason.
export const LIMITS = {
  max_wages: 200000, // above this, Additional Medicare Tax (Form 8959) and CTC phase-out start to matter
  max_qualifying_children: 2, // three or more children use Schedule 8812 Part II-B, not implemented
};

export const OTHER_SITUATIONS = {
  none: 'None of these apply',
  tips: 'Tips (Schedule 1-A, no tax on tips)',
  overtime: 'Overtime pay (Schedule 1-A, no tax on overtime)',
  car_loan_interest: 'Car loan interest (Schedule 1-A)',
  self_employment: 'Self-employment or 1099-NEC income',
  investment_income: 'Interest, dividends or other investment income',
  capital_gains: 'Capital gains or losses, crypto sales',
  retirement_income: 'Retirement distributions or pensions',
  unemployment: 'Unemployment compensation',
  social_security: 'Social Security benefits',
  itemized_deductions: 'Itemized deductions (Schedule A)',
  charitable_donations: 'Charitable cash donations (2026 deduction for non-itemizers)',
  hsa_or_ira: 'HSA or traditional IRA contributions',
  student_loan_interest: 'Student loan interest',
  education_expenses: 'Education credits or tuition',
  child_care: 'Child and dependent care expenses',
  marketplace_health_insurance: 'Marketplace health insurance (Form 1095-A)',
  foreign_income: 'Foreign income',
  part_year_or_nonresident: 'Part-year resident or nonresident alien',
  other: 'Anything else not listed',
};
