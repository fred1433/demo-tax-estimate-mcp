// Estimate references. The estimate tool persists nothing: its reference is a signed, compact
// record of the inputs, the engine version and the time it was issued. Save verifies the
// signature, refuses an expired or foreign reference with an explicit error, recomputes with the
// same engine version (deterministic) and checks that the result equals the one shown.
import { ENGINE } from './params.js';

const TTL_SECONDS = 24 * 3600;
const STATUS = { single: 's', married_filing_jointly: 'j', head_of_household: 'h' };
const STATUS_BACK = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return b64u(sig.slice(0, 18));
}

export async function issueEstimateId(secret, profile, result, nowSeconds = Math.floor(Date.now() / 1000)) {
  const rec = [
    1, ENGINE.version, nowSeconds, profile.tax_year, STATUS[profile.filing_status],
    profile.head_of_household_confirmed === true ? 1 : 0, profile.w2_wages, profile.federal_income_tax_withheld,
    profile.qualifying_children_under_17, profile.children_meet_ctc_rules === true ? 1 : 0,
    result.outcome === 'amount_owed' ? -result.amount : result.amount,
  ];
  const payload = b64u(new TextEncoder().encode(JSON.stringify(rec)));
  return { estimate_id: `est_${payload}.${await hmac(secret, payload)}`, expires_at: new Date((nowSeconds + TTL_SECONDS) * 1000).toISOString() };
}

// Returns { ok: true, profile, signedAmount, issuedAt } or { ok: false, code, message }.
export async function readEstimateId(secret, id, nowSeconds = Math.floor(Date.now() / 1000)) {
  const m = typeof id === 'string' && /^est_([A-Za-z0-9_-]{8,600})\.([A-Za-z0-9_-]{24})$/.exec(id);
  if (!m) return { ok: false, code: 'estimate_not_found', message: 'This estimate reference is not valid. Run the estimate again.' };
  if ((await hmac(secret, m[1])) !== m[2]) return { ok: false, code: 'estimate_not_found', message: 'This estimate reference was not issued by this server. Run the estimate again.' };
  let rec;
  try { rec = JSON.parse(new TextDecoder().decode(fromB64u(m[1]))); } catch { return { ok: false, code: 'estimate_not_found', message: 'This estimate reference is not valid. Run the estimate again.' }; }
  const [v, engineVersion, iat, year, st, hoh, wages, withheld, kids, ctcOk, signedAmount] = rec;
  if (v !== 1) return { ok: false, code: 'estimate_not_found', message: 'Unknown estimate reference format.' };
  if (nowSeconds - iat > TTL_SECONDS) return { ok: false, code: 'estimate_expired', message: 'This estimate is more than 24 hours old and was not saved. Run the estimate again to get a fresh one.' };
  if (engineVersion !== ENGINE.version) return { ok: false, code: 'engine_changed', message: `This estimate was made with engine ${engineVersion}; the server now runs ${ENGINE.version}. Run the estimate again before saving.` };
  const profile = {
    tax_year: year, filing_status: STATUS_BACK[st], w2_wages: wages, federal_income_tax_withheld: withheld,
    qualifying_children_under_17: kids, other_dependents: 0, taxpayer_age_65_or_older: false, taxpayer_blind: false,
    can_be_claimed_as_dependent: false, other_situations: ['none'],
  };
  if (hoh) profile.head_of_household_confirmed = true;
  if (ctcOk) profile.children_meet_ctc_rules = true;
  if (profile.filing_status === 'married_filing_jointly') Object.assign(profile, { spouse_age_65_or_older: false, spouse_blind: false });
  return { ok: true, profile, signedAmount, issuedAt: iat };
}
