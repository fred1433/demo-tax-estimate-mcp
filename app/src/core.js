// The two operations, shared by the MCP endpoints and the web twin's API.
import { estimate } from './engine.js';
import { issueEstimateId, readEstimateId } from './estimate-id.js';
import { buildServerEvent } from './meta.js';
import { ENGINE } from './params.js';

const ACCOUNT_DAYS = 7;
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');
const money = (n) => '$' + n.toLocaleString('en-US');

export function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return 'demo account';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

export function accountLabel(id) {
  return `Demo account ${id.slice(-4).toUpperCase()}`;
}

// Text a host shows or reads when the card does not render. Written by code from the result.
export function estimateText(r) {
  if (r.status !== 'estimated') {
    return `No estimate: this case is outside the stand-in engine.\n${r.reasons.map((x) => `- ${x.message}`).join('\n')}`;
  }
  const L = r.lines;
  const head = r.outcome === 'refund' ? `Estimated federal refund for ${r.tax_year}: ${money(r.amount)}.` : r.outcome === 'amount_owed' ? `Estimated federal amount owed for ${r.tax_year}: ${money(r.amount)}.` : `Estimated federal balance for ${r.tax_year}: $0.`;
  return [
    head,
    `Taxable income ${money(L.taxable_income_15)}; tax ${money(L.tax_16)}; child tax credit ${money(L.child_tax_credit_19)}; total tax ${money(L.total_tax_24)}.`,
    `Payments ${money(L.total_payments_33)} (withholding ${money(L.federal_withholding_25d)}${L.additional_child_tax_credit_28 ? `, additional child tax credit ${money(L.additional_child_tax_credit_28)}` : ''}).`,
    r.parameters_status === 'draft' ? 'Based on the IRS draft 2026 tables (Aug 28, 2026).' : 'Based on final 2025 IRS tables.',
    `Estimate reference: ${r.estimate_id} (valid 24 hours). To keep it, call save_estimate with this reference.`,
    'Stand-in engine for a demo, not tax advice and not FileTax.com\'s engine.',
  ].join('\n');
}

export async function runEstimate(env, profile) {
  const r = estimate(profile);
  if (r.status !== 'estimated') return r;
  const ref = await issueEstimateId(env.ESTIMATE_SECRET, { tax_year: 2026, ...profile }, r);
  return { ...r, ...ref };
}

function summary(r) {
  return { tax_year: r.tax_year, outcome: r.outcome, amount: r.amount, filing_status: r.filing_status, lines: r.lines, parameters_status: r.parameters_status };
}

export async function getAccount(env, id) {
  return env.DB.prepare('SELECT id, email, created_at, expires_at FROM accounts WHERE id = ?1 AND expires_at > ?2').bind(id, Date.now()).first();
}

export async function createAccount(env, email, createdVia) {
  const id = `acct_${rand(14)}`;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO accounts (id, email, created_at, expires_at, created_via) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, email, now, now + ACCOUNT_DAYS * 86400000, createdVia).run();
  const ev = await buildServerEvent({ kind: 'account_created', accountId: id, email, surface: createdVia, eventKey: id });
  await env.DB.prepare('INSERT INTO server_events (event_id, account_id, created_at, payload) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(event_id) DO NOTHING')
    .bind(ev.event_id, id, now, JSON.stringify(ev)).run();
  return { id, email, created_at: now };
}

// Save one estimate into one account. The owner comes from the validated token, never from the
// caller's arguments. Unique (account, estimate): a double click, a lost response or the host's
// retry after sign-in returns the same record.
export async function saveEstimate(env, { accountId, estimateId, surface }) {
  const ref = await readEstimateId(env.ESTIMATE_SECRET, estimateId);
  if (!ref.ok) return { status: 'error', error: ref.code, message: ref.message };
  const r = estimate(ref.profile);
  const signed = r.outcome === 'amount_owed' ? -r.amount : r.amount;
  if (r.status !== 'estimated' || signed !== ref.signedAmount) {
    return { status: 'error', error: 'estimate_mismatch', message: 'The saved result would differ from the one shown. Nothing was saved. Run the estimate again.' };
  }
  const account = await getAccount(env, accountId);
  if (!account) return { status: 'error', error: 'account_not_found', message: 'This demo account no longer exists (demo accounts are deleted after 7 days). Sign in again.' };
  const newId = `sav_${rand(12)}`;
  const now = Date.now();
  const snapshot = JSON.stringify({ engine: ENGINE, issued_at: ref.issuedAt, ...summary(r), parameters_note: r.parameters_note, assumptions: r.assumptions, sources: r.sources });
  await env.DB.prepare('INSERT INTO saves (id, account_id, estimate_id, saved_at, surface, snapshot) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(account_id, estimate_id) DO NOTHING')
    .bind(newId, accountId, estimateId, now, surface, snapshot).run();
  const row = await env.DB.prepare('SELECT id, saved_at, surface, snapshot FROM saves WHERE account_id = ?1 AND estimate_id = ?2').bind(accountId, estimateId).first();
  const alreadySaved = row.id !== newId;
  // Always try the event insert for the canonical record: if a first attempt was cut short after
  // the save was written, a retried Save restores it. The event_id makes it a no-op otherwise.
  const serverEvent = await buildServerEvent({ kind: 'estimate_saved', accountId, email: account.email, surface: row.surface, eventKey: row.id, now: row.saved_at });
  await env.DB.prepare('INSERT INTO server_events (event_id, account_id, created_at, payload) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(event_id) DO NOTHING')
    .bind(serverEvent.event_id, accountId, row.saved_at, JSON.stringify(serverEvent)).run();
  const saved = JSON.parse(row.snapshot);
  return {
    status: 'saved',
    record_id: row.id,
    estimate_id: estimateId,
    saved_at: new Date(row.saved_at).toISOString(),
    already_saved: alreadySaved,
    saved_from: row.surface,
    account: { id: accountId, label: accountLabel(accountId), email_hint: maskEmail(account.email) },
    // Records saved before sources were kept get them from the recomputation above, which ran on
    // the same engine version and gave the same result.
    estimate: {
      tax_year: saved.tax_year, outcome: saved.outcome, amount: saved.amount, filing_status: saved.filing_status, lines: saved.lines,
      parameters_status: saved.parameters_status, parameters_note: saved.parameters_note ?? r.parameters_note,
      engine: saved.engine ?? ENGINE, assumptions: saved.assumptions ?? r.assumptions, sources: saved.sources ?? r.sources,
    },
  };
}

export function saveText(s) {
  if (s.status !== 'saved') return `Not saved: ${s.message}`;
  const what = s.estimate.outcome === 'refund' ? `refund of ${money(s.estimate.amount)}` : s.estimate.outcome === 'amount_owed' ? `amount owed of ${money(s.estimate.amount)}` : 'balance of $0';
  return `${s.already_saved ? 'Already saved' : 'Saved'}: the ${s.estimate.tax_year} estimate (${what}) is in ${s.account.label} (${s.account.email_hint}), record ${s.record_id}, saved ${s.saved_at}.`;
}

export async function serverEventsFor(env, accountId) {
  const { results } = await env.DB.prepare('SELECT payload FROM server_events WHERE account_id = ?1 ORDER BY created_at').bind(accountId).all();
  return results.map((x) => JSON.parse(x.payload));
}

// Deletes expired demo accounts and their data; returns their ids so the caller revokes their grants.
export async function purge(env) {
  const now = Date.now();
  const old = await env.DB.prepare('SELECT id FROM accounts WHERE expires_at <= ?1').bind(now).all();
  for (const { id } of old.results) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM saves WHERE account_id = ?1').bind(id),
      env.DB.prepare('DELETE FROM server_events WHERE account_id = ?1').bind(id),
      env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(id),
    ]);
  }
  return old.results.map((x) => x.id);
}
