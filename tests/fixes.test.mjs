// Regression tests for the review pass of Nov 2, 2026 (blockers 0, 0 bis, 1 and the small server
// points that a unit test can reach). Each one failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimate } from '../app/src/engine.js';
import { requester, authorizePage } from '../app/src/pages.js';
import { buildServerEvent } from '../app/src/meta.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const BASE = { tax_year: 2026, filing_status: 'single', qualifying_children_under_17: 0, other_dependents: 0, taxpayer_age_65_or_older: false, taxpayer_blind: false, can_be_claimed_as_dependent: false, other_situations: ['none'] };

test('0: withholding above wages is refused with its reason, never turned into a refund', () => {
  for (const [w2_wages, federal_income_tax_withheld] of [[100000, 10000000], [50000, 60000]]) {
    const r = estimate({ ...BASE, w2_wages, federal_income_tax_withheld });
    assert.equal(r.status, 'unsupported_scenario', `${w2_wages}/${federal_income_tax_withheld}`);
    assert.ok(r.reasons.some((x) => x.code === 'withholding_above_wages'));
  }
  assert.equal(estimate({ ...BASE, w2_wages: 58400, federal_income_tax_withheld: 6050 }).amount, 1219);
});

test('0: the input schema caps withholding at the engine wage limit', async () => {
  const { ESTIMATE_INPUT } = await import('../app/src/mcp.js');
  assert.ok(ESTIMATE_INPUT.properties.federal_income_tax_withheld.maximum <= 200000);
});

const consent = (o) => ({ clientId: 'x', clientName: 'x', redirectUri: 'https://attacker.example/cb', redirectHost: 'attacker.example', redirectIsLoopback: false, scope: ['estimates:write'], ...o });

test('0 bis: a self-registered client named "ChatGPT" or "Claude" is shown as an unverified app', () => {
  for (const name of ['ChatGPT', 'Claude', 'The web estimator']) {
    const d = consent({ clientId: 'dcr_abc', clientName: name });
    const who = requester(d);
    assert.equal(who.name, 'An unverified app (attacker.example)');
    assert.equal(who.kind, 'other');
    assert.equal(who.verified, false);
    const html = authorizePage({ details: d, handle: 'h', existing: null });
    assert.ok(!html.includes(name), `page must not show the self-asserted name ${name}`);
    assert.ok(html.includes('An unverified app (attacker.example)'));
  }
});

test('0 bis: only the hosts\' known client IDs or exact redirect URIs are named', () => {
  const chatgpt = requester(consent({ clientId: 'https://chatgpt.com/oauth/client.json', clientDomain: 'chatgpt.com', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', redirectHost: 'chatgpt.com' }));
  assert.deepEqual([chatgpt.name, chatgpt.kind, chatgpt.domain], ['ChatGPT', 'chatgpt', 'chatgpt.com']);
  const claude = requester(consent({ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', clientDomain: 'claude.ai', redirectUri: 'https://claude.ai/api/mcp/auth_callback', redirectHost: 'claude.ai' }));
  assert.deepEqual([claude.name, claude.kind], ['Claude', 'claude']);
  const claudeDcr = requester(consent({ clientId: 'dcr_x', clientName: 'anything', redirectUri: 'https://claude.ai/api/mcp/auth_callback', redirectHost: 'claude.ai' }));
  assert.deepEqual([claudeDcr.name, claudeDcr.kind], ['Claude', 'claude']);
  const web = requester(consent({ clientId: 'https://theaipipe.com/demos/tax-estimate-mcp/oauth-client.json', clientDomain: 'theaipipe.com', redirectUri: 'https://theaipipe.com/demos/tax-estimate-mcp/', redirectHost: 'theaipipe.com' }));
  assert.deepEqual([web.name, web.kind], ['The web estimator', 'web']);
  // a CIMD document on a known domain but at another URL is not one of the hosts' clients
  const other = requester(consent({ clientId: 'https://claude.ai/some/other-client.json', clientDomain: 'claude.ai', redirectUri: 'https://attacker.example/cb', redirectHost: 'attacker.example' }));
  assert.equal(other.kind, 'other');
});

test('1: the sign-up page promises per host only what the host runs showed; 11: a made-up email works', () => {
  const page = (o) => authorizePage({ details: consent(o), handle: 'h', existing: null });
  const claude = page({ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', clientDomain: 'claude.ai', redirectUri: 'https://claude.ai/api/mcp/auth_callback', redirectHost: 'claude.ai' });
  const chatgpt = page({ clientId: 'https://chatgpt.com/oauth/client.json', clientDomain: 'chatgpt.com', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', redirectHost: 'chatgpt.com' });
  const web = page({ clientId: 'https://theaipipe.com/demos/tax-estimate-mcp/oauth-client.json', clientDomain: 'theaipipe.com', redirectUri: 'https://theaipipe.com/demos/tax-estimate-mcp/', redirectHost: 'theaipipe.com' });
  for (const html of [claude, chatgpt, web]) {
    assert.ok(!/straight back/.test(html));
    assert.ok(html.includes('any made-up address works'));
  }
  assert.ok(claude.includes('After you continue, Claude returns to your conversation and finishes the save.'));
  assert.ok(chatgpt.includes('After connecting, reopen your conversation and press Save again.'));
  assert.ok(!/returns to your conversation/.test(chatgpt));
  assert.ok(web.includes('back on the demo page'));
});

test('1: the save tool and the card do not promise an automatic retry', async () => {
  const { SAVE_DESCRIPTION } = await import('../app/src/mcp.js');
  assert.ok(SAVE_DESCRIPTION && !/retries this same call/.test(SAVE_DESCRIPTION));
  assert.ok(/same estimate_id/.test(SAVE_DESCRIPTION));
  for (const f of ['card/mcp-entry.js', 'app/src/card.generated.js']) assert.ok(!read(f).includes('then saves it'), f);
});

test('1: the proofs page reports the host runs from host-runs.json, never "not yet run"', () => {
  const runs = JSON.parse(read('page/site/data/host-runs.json'));
  const proofs = read('page/site/proofs.html');
  assert.ok(!/not yet run/.test(proofs));
  for (const h of ['claude', 'chatgpt']) assert.ok(proofs.includes(runs[h].surface), h);
  assert.ok(/iPhone/.test(proofs) && /not tested/.test(proofs));
});

test('9: every sample prompt answers the questions the tool requires', () => {
  const twin = read('page/site/twin.js');
  const prompts = [...twin.matchAll(/prompt: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(prompts.length, 3);
  for (const p of prompts) assert.match(p, /under 65.*not blind.*dependent.*no other income/i, p);
  assert.match(read('HOST_TESTS.md'), /under 65, not blind, nobody can claim me as a dependent, no other income or situations/);
});

test('18 bis: the Meta event_id does not carry the account or record id in clear', async () => {
  const ev = await buildServerEvent({ kind: 'account_created', accountId: 'acct_3t3scuze5zveza', email: 'a@b.co', surface: 'web', eventKey: 'acct_3t3scuze5zveza' });
  assert.ok(!ev.event_id.includes('acct_'));
  assert.match(ev.event_id, /^account_created_[0-9a-f]{32}$/);
  const again = await buildServerEvent({ kind: 'account_created', accountId: 'acct_3t3scuze5zveza', email: 'a@b.co', surface: 'web', eventKey: 'acct_3t3scuze5zveza' });
  assert.equal(again.event_id, ev.event_id, 'deterministic, so deduplication still works');
});

test('18 ter and 18 quater: no truncated notes in the proofs, no em dash in the reference script', () => {
  assert.ok(!read('scripts/build-proofs.mjs').includes('slice(0, 220)'));
  assert.ok(!read('reference/derive_expected.py').includes('\u2014'));
});
