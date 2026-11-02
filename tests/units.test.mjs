// Estimate references, closed-list telemetry, Meta preview contents, card text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueEstimateId, readEstimateId } from '../app/src/estimate-id.js';
import { sanitizeEvent } from '../app/src/telemetry.js';
import { buildServerEvent } from '../app/src/meta.js';
import { estimate } from '../app/src/engine.js';
import { estimateText } from '../app/src/core.js';

const P = { tax_year: 2026, filing_status: 'married_filing_jointly', w2_wages: 128000, federal_income_tax_withheld: 9600, qualifying_children_under_17: 2, children_meet_ctc_rules: true, other_dependents: 0, taxpayer_age_65_or_older: false, spouse_age_65_or_older: false, taxpayer_blind: false, spouse_blind: false, can_be_claimed_as_dependent: false, other_situations: ['none'] };
const S = 'unit-test-secret-0123456789abcdef0123';

test('estimate reference round-trips to the same profile and result', async () => {
  const r = estimate(P);
  const { estimate_id } = await issueEstimateId(S, P, r);
  const back = await readEstimateId(S, estimate_id);
  assert.equal(back.ok, true);
  const again = estimate(back.profile);
  assert.deepEqual(again.lines, r.lines);
  assert.equal(back.signedAmount, r.amount);
});

test('estimate reference: tampered, foreign secret and expired are explicit errors', async () => {
  const r = estimate(P);
  const now = Math.floor(Date.now() / 1000);
  const { estimate_id } = await issueEstimateId(S, P, r, now);
  const [payload, sig] = estimate_id.slice(4).split('.');
  const forged = `est_${payload.slice(0, -2)}AA.${sig}`;
  assert.equal((await readEstimateId(S, forged)).code, 'estimate_not_found');
  assert.equal((await readEstimateId('another-secret-0123456789abcdef0123', estimate_id)).code, 'estimate_not_found');
  assert.equal((await readEstimateId(S, estimate_id, now + 25 * 3600)).code, 'estimate_expired');
  assert.equal((await readEstimateId(S, 'not-an-id')).code, 'estimate_not_found');
});

test('telemetry keeps only the closed list of fields and values', () => {
  const out = sanitizeEvent('tool_save', { surface: 'claude', outcome: 'ok', ms: 12.4, cid: 'a1b2c3d4e5f6', code: 'saved', wages: 73417, email: 'x@y.z', token: 'abc', message: 'boom' });
  assert.deepEqual(out, { evt: 'tool_save', surface: 'claude', outcome: 'ok', ms: 12, cid: 'a1b2c3d4e5f6', code: 'saved' });
  assert.deepEqual(sanitizeEvent('made_up', { code: 'Refund $2,997 for jordan@example.com' }), { evt: 'error', code: 'other' });
  assert.equal(sanitizeEvent('mcp_request', { surface: 'attacker' }).surface, undefined);
});

test('Meta preview carries no amount, no tax detail, no IP, and hashes identifiers', async () => {
  const ev = await buildServerEvent({ kind: 'estimate_saved', accountId: 'acct_test123', email: ' Jordan@Example.com ', surface: 'chatgpt', eventKey: 'sav_abc' });
  const s = JSON.stringify(ev.payload);
  assert.equal(ev.status, 'preview_not_sent');
  for (const banned of ['2997', '128000', 'refund', 'amount', 'tax_year', '2026', 'client_ip_address', 'client_user_agent', 'jordan@example.com', 'acct_test123']) {
    assert.ok(!s.toLowerCase().includes(banned.toLowerCase()), banned);
  }
  const d = ev.payload.data[0];
  assert.equal(d.action_source, 'chat');
  assert.equal(d.event_id, 'estimate_saved_sav_abc');
  assert.match(d.user_data.em[0], /^[0-9a-f]{64}$/);
});

test('text fallback is written from the result, with the reference', () => {
  const r = { ...estimate(P), estimate_id: 'est_x.y' };
  const t = estimateText(r);
  assert.match(t, /Estimated federal refund for 2026: \$2,997\./);
  assert.match(t, /est_x\.y/);
});
