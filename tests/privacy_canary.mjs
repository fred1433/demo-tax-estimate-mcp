// Privacy check on real telemetry. Plays success, refusal, validation error, sign-in denial,
// sign-in, Save, repeated Save, tampered and expired references and an invalid token with
// recognisable values, then searches the captured logs for every one of them.
//
// Usage:
//   node tests/privacy_canary.mjs <base-url> --log <file written by wrangler dev>   (local run)
//   node tests/privacy_canary.mjs <base-url> --cf                                    (deployed Worker: queries Workers Logs)
import { Client, StreamableHTTPClientTransport, UnauthorizedError, auth } from '@modelcontextprotocol/client';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2].replace(/\/$/, '');
const LOG = process.argv.includes('--log') ? process.argv[process.argv.indexOf('--log') + 1] : null;
const CF = process.argv.includes('--cf');
const SECRET = process.argv.includes('--secret') ? process.argv[process.argv.indexOf('--secret') + 1] : null;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const tag = Math.random().toString(36).slice(2, 8);
const canary = {
  wages: 73417, withheld: 8123,
  email: `canary-${tag}@example.org`,
};
const profile = { tax_year: 2026, filing_status: 'single', w2_wages: canary.wages, federal_income_tax_withheld: canary.withheld, qualifying_children_under_17: 0, other_dependents: 0, taxpayer_age_65_or_older: false, taxpayer_blind: false, can_be_claimed_as_dependent: false, other_situations: ['none'] };
const seen = {}; // every secret-ish value the run handles, to search for afterwards
const remember = (k, v) => { if (v) seen[k] = String(v); };
const startedAt = Date.now();
const logStart = LOG ? statSync(LOG).size : 0;

function prov() {
  const s = {};
  return { _s: s, get redirectUrl() { return REDIRECT; }, get clientMetadata() { return { client_name: `canary ${tag}`, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }; },
    clientInformation: () => s.ci, saveClientInformation: (i) => { s.ci = i; remember('client_id', i.client_id); }, tokens: () => s.t, saveTokens: (t) => { s.t = t; remember('access_token', t.access_token); remember('refresh_token', t.refresh_token); },
    redirectToAuthorization: (u) => { s.u = u; remember('code_challenge', u.searchParams.get('code_challenge')); remember('oauth_state', u.searchParams.get('state')); }, saveCodeVerifier: (v) => { s.v = v; remember('code_verifier', v); }, codeVerifier: () => s.v,
    saveDiscoveryState: (d) => { s.d = d; }, discoveryState: () => s.d };
}
async function browser(u, action, email) {
  const jar = {};
  const keep = (r) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const ck = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const g = await fetch(u, { redirect: 'manual' }); keep(g);
  const handle = /name="handle" value="([^"]+)"/.exec(await g.text())[1];
  const p = await fetch(u, { method: 'POST', redirect: 'manual', headers: { Cookie: ck(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, action, email }) });
  const cb = new URL(p.headers.get('location'));
  remember('authorization_code', cb.searchParams.get('code'));
  return cb.searchParams;
}
const connect = async (surface, p) => { const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${surface}`), { authProvider: p }); const c = new Client({ name: 'canary', version: '1' }); await c.connect(t); return { c, t }; };

const steps = [];
for (const surface of ['claude', 'chatgpt']) {
  const p = prov();
  let { c, t } = await connect(surface, p);
  const e = (await c.callTool({ name: 'estimate_federal_tax', arguments: profile })).structuredContent;
  remember(`estimate_id_${surface}`, e.estimate_id);
  canary.amount = e.amount; canary.taxable = e.lines.taxable_income_15; canary.tax = e.lines.tax_16;
  steps.push(`${surface}: estimate ${e.status}`);
  await c.callTool({ name: 'estimate_federal_tax', arguments: { ...profile, other_situations: ['overtime'] } }); steps.push(`${surface}: refusal`);
  try { await c.callTool({ name: 'estimate_federal_tax', arguments: { ...profile, w2_wages: 'seventy' } }); } catch {} steps.push(`${surface}: validation error`);
  // denied sign-in
  if (surface === 'claude') { try { await c.callTool({ name: 'save_estimate', arguments: { estimate_id: e.estimate_id } }); } catch (x) { if (!(x instanceof UnauthorizedError)) throw x; } }
  else { await c.callTool({ name: 'save_estimate', arguments: { estimate_id: e.estimate_id } }); await auth(p, { serverUrl: `${BASE}/mcp/${surface}` }); }
  await browser(p._s.u, 'deny', ''); steps.push(`${surface}: sign-in denied`);
  // sign-in again, accepted
  if (surface === 'claude') { try { await c.callTool({ name: 'save_estimate', arguments: { estimate_id: e.estimate_id } }); } catch {} const q = await browser(p._s.u, 'create', canary.email); await t.finishAuth(q); }
  else { await auth(p, { serverUrl: `${BASE}/mcp/${surface}` }); const q = await browser(p._s.u, 'create', canary.email); await auth(p, { serverUrl: `${BASE}/mcp/${surface}`, authorizationCode: q.get('code'), iss: q.get('iss') }); }
  ({ c, t } = await connect(surface, p));
  const s1 = (await c.callTool({ name: 'save_estimate', arguments: { estimate_id: e.estimate_id } })).structuredContent;
  remember(`record_id_${surface}`, s1.record_id); remember(`account_id_${surface}`, s1.account.id);
  await c.callTool({ name: 'save_estimate', arguments: { estimate_id: e.estimate_id } });
  steps.push(`${surface}: signed up, saved ${s1.status}, saved again`);
  await c.callTool({ name: 'save_estimate', arguments: { estimate_id: e.estimate_id.slice(0, -4) + 'AAAA' } }); steps.push(`${surface}: tampered reference`);
  if (SECRET) {
    const { issueEstimateId } = await import('../app/src/estimate-id.js');
    const old = await issueEstimateId(SECRET, profile, e, Math.floor(Date.now() / 1000) - 90000);
    await c.callTool({ name: 'save_estimate', arguments: { estimate_id: old.estimate_id } }); steps.push(`${surface}: expired reference`);
  }
  const bad = await fetch(`${BASE}/mcp/${surface}`, { method: 'POST', headers: { Authorization: `Bearer ${p._s.t.access_token}x`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' });
  steps.push(`${surface}: invalid token ${bad.status}`);
  // refresh token use
  await auth(p, { serverUrl: `${BASE}/mcp/${surface}` }).catch(() => {}); steps.push(`${surface}: refresh`);
}

async function collect() {
  if (LOG) {
    await new Promise((r) => setTimeout(r, 1500));
    const all = readFileSync(LOG, 'utf8').slice(logStart);
    const lines = all.split('\n').filter(Boolean);
    return { source: `wrangler dev output (${LOG})`, worker: lines.filter((l) => l.startsWith('{')), devServer: lines.filter((l) => !l.startsWith('{')) };
  }
  // Workers Logs (persisted) via the observability telemetry API
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  await new Promise((r) => setTimeout(r, 180000));
  const body = { queryId: 'canary', timeframe: { from: startedAt - 60000, to: Date.now() + 60000 }, view: 'events', limit: 2000, parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'tax-mcp-demo' }] } };
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/observability/telemetry/query`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.success) throw new Error(`telemetry query failed: ${JSON.stringify(j.errors).slice(0, 300)}`);
  const events = j.result?.events?.events ?? [];
  return { source: 'Cloudflare Workers Logs (telemetry query API)', worker: events.map((e) => JSON.stringify(e)), devServer: [] };
}

const logs = await collect();
const needles = { ...Object.fromEntries(Object.entries(seen)), email: canary.email, wages: String(canary.wages), wages_fmt: canary.wages.toLocaleString('en-US'), withheld: String(canary.withheld), withheld_fmt: canary.withheld.toLocaleString('en-US'), amount: String(canary.amount), taxable: String(canary.taxable), tax: String(canary.tax) };
const hits = [];
const coincidences = [];
for (const [k, v] of Object.entries(needles)) {
  if (!v || v.length < 4) continue;
  for (const l of logs.worker) {
    const i = l.indexOf(v);
    if (i < 0) continue;
    const context = l.slice(Math.max(0, i - 40), i + v.length + 20);
    // A five-digit amount can occur by chance inside the platform's own hex identifiers
    // (requestId, traceId, spanId, $metadata.id). Those are reported apart, with their context.
    const inPlatformId = /"(requestId|traceId|spanId|id|rayId)":"[0-9A-Za-z]*$/.test(l.slice(0, i)) && /^[0-9A-Za-z]*"/.test(l.slice(i));
    (inPlatformId ? coincidences : hits).push({ where: 'worker logs', needle: k, context });
  }
}
const devHits = [];
for (const [k, v] of Object.entries(needles)) for (const l of logs.devServer) if (v && v.length >= 4 && l.includes(v)) devHits.push({ needle: k, line: l.slice(0, 160) });
const keys = new Set(); for (const l of logs.worker) { try { const o = JSON.parse(l); for (const k of Object.keys(o.source ?? o)) keys.add(k); } catch {} }
const report = { target: BASE, at: new Date().toISOString(), source: logs.source, steps, worker_log_lines: logs.worker.length, needles_searched: Object.keys(needles).length, hits, coincidences_inside_platform_ids: coincidences, fields_seen: [...keys].sort(), dev_server_lines_with_values: devHits.length };
console.log(JSON.stringify({ ...report, sample: logs.worker.slice(0, 5) }, null, 2));
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/privacy-${LOG ? 'local' : 'production'}.json`, import.meta.url), JSON.stringify(report, null, 2));
process.exit(hits.length === 0 && logs.worker.length > 0 ? 0 : 1);
