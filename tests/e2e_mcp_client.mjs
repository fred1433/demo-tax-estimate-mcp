// End-to-end proof with a real MCP client (@modelcontextprotocol/client 2.4.0) against a running
// server: anonymous estimate, the sign-in signal of each host shape (HTTP 401 on /mcp/claude,
// tool error with _meta["mcp/www_authenticate"] on /mcp/chatgpt), OAuth with account creation
// during authorization, resumption of the same Save call, idempotent Save, owner from the token,
// explicit errors. The browser part of OAuth (the sign-up form) is driven with plain HTTP.
//
// Usage: node tests/e2e_mcp_client.mjs <base-url> [--secret <ESTIMATE_SECRET for the expiry test>]
import { Client, StreamableHTTPClientTransport, UnauthorizedError, auth } from '@modelcontextprotocol/client';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SECRET = process.argv.includes('--secret') ? process.argv[process.argv.indexOf('--secret') + 1] : null;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const fx = JSON.parse(readFileSync(new URL('./fixtures/profiles.json', import.meta.url)));
const expected = JSON.parse(readFileSync(new URL('./fixtures/expected.json', import.meta.url))).expected;
const P01 = { ...fx.common, ...fx.profiles[0] };
delete P01.id; delete P01.label;

const results = [];
const log = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail.note ? ' :: ' + detail.note : ''}`); };
const httpTrace = [];

// fetch wrapper that records status and WWW-Authenticate of every MCP call
const tracingFetch = async (url, init) => {
  const res = await fetch(url, init);
  let method = null;
  try { method = JSON.parse(init?.body ?? 'null')?.method ?? null; } catch {}
  httpTrace.push({ url: String(url).replace(BASE, ''), method, status: res.status, www_authenticate: res.headers.get('www-authenticate') });
  return res;
};

// Plays the user in the sign-up page: GET the authorization URL, submit the form, return the callback params.
async function signUp(authorizationUrl, email, { useExistingSession = null } = {}) {
  const t0 = Date.now();
  const cookies = {};
  const keep = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); } };
  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (useExistingSession) Object.assign(cookies, useExistingSession);
  const page = await fetch(authorizationUrl, { headers: { Cookie: cookieHeader() }, redirect: 'manual' });
  keep(page);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`authorize page ${page.status}: ${html.slice(0, 200)}`);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const form = new URLSearchParams(useExistingSession ? { handle, action: 'continue' } : { handle, action: 'create', email });
  const post = await fetch(authorizationUrl, { method: 'POST', body: form, headers: { Cookie: cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  keep(post);
  const loc = post.headers.get('location');
  if (post.status !== 302 || !loc) throw new Error(`authorize POST ${post.status}`);
  const cb = new URL(loc);
  return { params: cb.searchParams, html, cookies, ms: Date.now() - t0, redirectOrigin: cb.origin + cb.pathname };
}

function provider(label) {
  const state = { clientInfo: undefined, tokens: undefined, verifier: undefined, lastAuthUrl: undefined, discovery: undefined };
  return {
    _s: state,
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return { client_name: `E2E test client (${label})`, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' };
    },
    clientInformation: () => state.clientInfo,
    saveClientInformation: (i) => { state.clientInfo = i; },
    tokens: () => state.tokens,
    saveTokens: (t) => { state.tokens = t; },
    redirectToAuthorization: (u) => { state.lastAuthUrl = u; },
    saveCodeVerifier: (v) => { state.verifier = v; },
    codeVerifier: () => state.verifier,
    saveDiscoveryState: (d) => { state.discovery = d; },
    discoveryState: () => state.discovery,
  };
}

async function connect(surface, prov) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${surface}`), { authProvider: prov, fetch: tracingFetch });
  const client = new Client({ name: 'e2e-mcp-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function legacyInitialize(surface) {
  // A 2025-era client: initialize handshake, then tools/list, over plain HTTP.
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const init = await fetch(`${BASE}/mcp/${surface}`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-probe', version: '1' } } }) });
  const text = await init.text();
  const body = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:')).slice(5));
  return { status: init.status, protocolVersion: body.result?.protocolVersion, hasInstructions: !!body.result?.instructions };
}

async function run(surface) {
  const S = surface.toUpperCase();
  const legacy = await legacyInitialize(surface);
  log(`${S} 2025-era initialize handshake answered`, legacy.status === 200 && !!legacy.protocolVersion, { note: `protocolVersion ${legacy.protocolVersion}` });

  const prov = provider(surface);
  let { client, transport } = await connect(surface, prov);
  const tools = (await client.listTools()).tools;
  const est = tools.find((t) => t.name === 'estimate_federal_tax');
  const sav = tools.find((t) => t.name === 'save_estimate');
  log(`${S} tools/list without sign-in returns both tools`, !!est && !!sav);
  log(`${S} annotations exact`, est.annotations.readOnlyHint === true && est.annotations.openWorldHint === false && sav.annotations.readOnlyHint === false && sav.annotations.destructiveHint === false && sav.annotations.idempotentHint === true && sav.annotations.openWorldHint === false);
  log(`${S} formal input and output schemas`, est.inputSchema.additionalProperties === false && !!est.outputSchema && sav.inputSchema.required?.[0] === 'estimate_id' && !!sav.outputSchema);
  log(`${S} card linked by _meta.ui.resourceUri`, est._meta?.ui?.resourceUri === 'ui://tax-estimate/card.html');
  if (surface === 'chatgpt') {
    log('CHATGPT securitySchemes: estimate noauth, save oauth2', est._meta?.securitySchemes?.[0]?.type === 'noauth' && sav._meta?.securitySchemes?.[0]?.type === 'oauth2');
  }
  const res = await client.readResource({ uri: 'ui://tax-estimate/card.html' });
  const c0 = res.contents[0];
  log(`${S} card resource is text/html;profile=mcp-app`, c0.mimeType === 'text/html;profile=mcp-app' && c0.text.length > 1000, { note: surface === 'claude' ? `ui.domain ${c0._meta?.ui?.domain}` : 'no ui.domain (ChatGPT default sandbox)' });

  // 1. anonymous estimate
  const t0 = Date.now();
  const e = await client.callTool({ name: 'estimate_federal_tax', arguments: P01 });
  const sc = e.structuredContent;
  log(`${S} anonymous estimate (no token)`, sc.status === 'estimated' && sc.amount === expected.p01.amount && sc.outcome === expected.p01.outcome && prov._s.tokens === undefined, { note: `${sc.outcome} ${sc.amount}, ${Date.now() - t0} ms` });
  const refused = await client.callTool({ name: 'estimate_federal_tax', arguments: { ...P01, other_situations: ['tips'] } });
  log(`${S} out-of-scope profile refused with a reason`, refused.structuredContent.status === 'unsupported_scenario' && refused.structuredContent.reasons.some((r) => r.code === 'situation_tips'));

  // 2. Save without a token
  const email = `e2e-${surface}-${Date.now()}@example.com`;
  const tSave = Date.now();
  let signup;
  if (surface === 'claude') {
    let threw = null;
    try { await client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id } }); } catch (err) { threw = err; }
    const challenge = httpTrace.filter((h) => h.status === 401).at(-1);
    log('CLAUDE Save without token: HTTP 401 with WWW-Authenticate before the MCP layer', threw instanceof UnauthorizedError && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp\/claude"/.test(challenge?.www_authenticate || ''), { note: challenge?.www_authenticate });
    signup = await signUp(prov._s.lastAuthUrl, email);
    await transport.finishAuth(signup.params);
  } else {
    const r = await client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id } });
    const www = r._meta?.['mcp/www_authenticate']?.[0] || '';
    log('CHATGPT Save without token: tool error carrying _meta["mcp/www_authenticate"] with error and error_description', r.isError === true && /error="/.test(www) && /error_description="/.test(www) && /oauth-protected-resource\/mcp\/chatgpt/.test(www), { note: www });
    const rm = /resource_metadata="([^"]+)"/.exec(www)[1];
    const a1 = await auth(prov, { serverUrl: `${BASE}/mcp/chatgpt`, resourceMetadataUrl: new URL(rm), fetchFn: tracingFetch });
    signup = await signUp(prov._s.lastAuthUrl, email);
    await auth(prov, { serverUrl: `${BASE}/mcp/chatgpt`, authorizationCode: signup.params.get('code'), iss: signup.params.get('iss'), fetchFn: tracingFetch });
    log('CHATGPT OAuth started from the challenge', a1 === 'REDIRECT');
  }
  const authUrl = new URL(prov._s.lastAuthUrl);
  log(`${S} authorization request: PKCE S256 and resource indicator`, authUrl.searchParams.get('code_challenge_method') === 'S256' && authUrl.searchParams.get('resource') === `${BASE}/mcp/${surface}`);
  log(`${S} sign-up page names the requesting app and the redirect host, no SSN field`, /App asking/.test(signup.html) && /127\.0\.0\.1/.test(signup.html) && !/ssn|social security number/i.test(signup.html.replace(/SSN valid/g, '')));
  log(`${S} RFC 9207 iss returned and equal to the issuer`, signup.params.get('iss') === BASE);
  log(`${S} account created during authorization, tokens issued`, !!prov._s.tokens?.access_token, { note: `sign-up round trip ${signup.ms} ms` });

  // 3. resume: the same Save call, now with the token
  ({ client, transport } = await connect(surface, prov));
  const s1 = await client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id } });
  const saved = s1.structuredContent;
  log(`${S} resumed Save stores the estimate shown`, saved.status === 'saved' && saved.already_saved === false && saved.estimate.amount === sc.amount && saved.estimate.outcome === sc.outcome, { note: `${saved.record_id} in ${saved.account?.label}, ${Date.now() - tSave} ms from the first Save` });
  // 4. idempotency: double click, lost response
  const [s2, s3] = await Promise.all([1, 2].map(() => client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id } })));
  log(`${S} Save repeated (twice in parallel) returns the same record`, [s2, s3].every((x) => x.structuredContent.record_id === saved.record_id && x.structuredContent.already_saved === true));
  // 5. the model cannot choose the owner
  let rejected = false;
  try {
    const r = await client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id, account_id: 'acct_someoneelse' } });
    rejected = r.isError === true;
  } catch { rejected = true; }
  log(`${S} an account_id argument is rejected by the schema`, rejected);
  // 6. explicit errors, never a silent recompute
  const bad = await client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id.slice(0, -3) + 'AAA' } });
  log(`${S} tampered reference: explicit error, nothing saved`, bad.isError === true && bad.structuredContent?.error === 'estimate_not_found');
  if (SECRET) {
    const { issueEstimateId } = await import('../app/src/estimate-id.js');
    const old = await issueEstimateId(SECRET, P01, { outcome: sc.outcome, amount: sc.amount }, Math.floor(Date.now() / 1000) - 25 * 3600);
    const ex = await client.callTool({ name: 'save_estimate', arguments: { estimate_id: old.estimate_id } });
    log(`${S} expired reference (25 h old): explicit estimate_expired error`, ex.isError === true && ex.structuredContent?.error === 'estimate_expired');
  }
  // 7. a second account saving the same estimate gets its own record
  const prov2 = provider(surface + '-2');
  let c2 = await connect(surface, prov2);
  if (surface === 'claude') {
    try { await c2.client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id } }); } catch {}
    const su = await signUp(prov2._s.lastAuthUrl, `e2e-second-${Date.now()}@example.com`);
    await c2.transport.finishAuth(su.params);
  } else {
    await auth(prov2, { serverUrl: `${BASE}/mcp/chatgpt`, fetchFn: tracingFetch });
    const su = await signUp(prov2._s.lastAuthUrl, `e2e-second-${Date.now()}@example.com`);
    await auth(prov2, { serverUrl: `${BASE}/mcp/chatgpt`, authorizationCode: su.params.get('code'), iss: su.params.get('iss'), fetchFn: tracingFetch });
  }
  c2 = await connect(surface, prov2);
  const other = (await c2.client.callTool({ name: 'save_estimate', arguments: { estimate_id: sc.estimate_id } })).structuredContent;
  log(`${S} owner comes from the token: a second account gets a separate record`, other.status === 'saved' && other.record_id !== saved.record_id && other.account.id !== saved.account.id);
  // 8. a token for the other endpoint is refused (audience)
  const other_surface = surface === 'claude' ? 'chatgpt' : 'claude';
  const wrong = await fetch(`${BASE}/mcp/${other_surface}`, { method: 'POST', headers: { Authorization: `Bearer ${prov._s.tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) });
  log(`${S} token refused on the other endpoint (audience check)`, wrong.status === 401);
  return { surface, record: saved.record_id };
}

const started = new Date().toISOString();
for (const s of ['claude', 'chatgpt']) {
  try { await run(s); } catch (err) { log(`${s.toUpperCase()} run aborted`, false, { note: String(err?.stack || err).slice(0, 400) }); }
}
// The hosts' own Client ID Metadata Documents resolve from the server (no code is redeemed).
if (!BASE.includes('127.0.0.1')) {
  const { createHash } = await import('node:crypto');
  const challenge = createHash('sha256').update('cimd-probe-verifier-0123456789abcdefghijklmnop').digest('base64url');
  for (const [name, cid, redirect, surface, expect] of [
    ['ChatGPT', 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect', 'chatgpt', 'ChatGPT (chatgpt.com)'],
    ['Claude Code', 'https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:4567/callback', 'claude', 'Claude (claude.ai)'],
  ]) {
    const u = new URL(`${BASE}/authorize`);
    Object.entries({ response_type: 'code', client_id: cid, redirect_uri: redirect, scope: 'estimates:write', state: 'probe', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp/${surface}` }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { redirect: 'manual' });
    const text = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    log(`${name}'s published CIMD document (${cid}) is fetched and accepted; the sign-up page names it`, r.status === 200 && text.includes(expect), { note: `HTTP ${r.status}` });
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed against ${BASE}`);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const tag = BASE.includes('127.0.0.1') ? 'local' : 'production';
writeFileSync(new URL(`./out/e2e-${tag}.json`, import.meta.url), JSON.stringify({ target: BASE, started, finished: new Date().toISOString(), client: '@modelcontextprotocol/client 2.4.0', pass, total: results.length, results, http: httpTrace.map((h) => ({ ...h, www_authenticate: h.www_authenticate ? h.www_authenticate.replace(/error_description="[^"]*"/, 'error_description="..."') : null })) }, null, 2));
process.exit(pass === results.length ? 0 : 1);
