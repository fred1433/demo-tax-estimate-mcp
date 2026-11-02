// tax-mcp-demo.theaipipe.com: MCP endpoints, OAuth authorization server, web twin API.
import './telemetry.js'; // first: replaces console output before any library loads
import { OAuthAuthorizationServer, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { logEvent, newCorrelationId, withRequestScope } from './telemetry.js';
import { makeHandlers, prmUrl, SCOPE } from './mcp.js';
import { authorizePage, errorPage, requester } from './pages.js';
import { runEstimate, saveEstimate, createAccount, getAccount, accountLabel, maskEmail, serverEventsFor, purge } from './core.js';

// Fixed in production by wrangler.toml [vars]; a local run overrides them in .dev.vars.
let ORIGIN, PAGE_ORIGIN, RESOURCES, authServer, mcp;
const SESSION_COOKIE = '__Host-taxdemo_session';

function init(env) {
  if (authServer) return;
  ORIGIN = env.ORIGIN;
  PAGE_ORIGIN = env.PAGE_ORIGIN;
  RESOURCES = { claude: `${ORIGIN}/mcp/claude`, chatgpt: `${ORIGIN}/mcp/chatgpt`, web: `${ORIGIN}/api/web` };
  authServer = new OAuthAuthorizationServer({
    issuer: ORIGIN,
    resources: Object.values(RESOURCES),
    scopesSupported: [SCOPE],
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 3600,
    // A grant lives no longer than the demo account it opens (accounts are deleted after 7 days).
    refreshTokenTTL: 7 * 86400,
    onError: ({ code }) => { logEvent('oauth_error', { surface: 'oauth', code: String(code).toLowerCase() }); },
  });
  const handlers = makeHandlers(ORIGIN);
  mcp = { claude: handlers.claude(env), chatgpt: handlers.chatgpt(env) };
}
const mcpFor = (surface) => mcp[surface];

function prm(resource, path) {
  return Response.json({
    resource,
    authorization_servers: [ORIGIN],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Tax estimate demo (The AI Pipe)',
    resource_documentation: 'https://theaipipe.com/demos/tax-estimate-mcp/',
  }, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
}

// RFC 6750 section 3.1: a request that sent no token gets a challenge without an error code;
// error="invalid_token" only when a token was sent and rejected, "insufficient_scope" for a token
// that lacks the permission.
function challenge(surface, error, description, status = 401) {
  const metadata = surface === 'web' ? `${ORIGIN}/.well-known/oauth-protected-resource/api/web` : prmUrl(ORIGIN, surface);
  const params = error ? `error="${error}", error_description="${description}", ` : '';
  return new Response(JSON.stringify(error ? { error, error_description: description } : { message: description }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer ${params}resource_metadata="${metadata}", scope="${SCOPE}"`,
      ...cors(surface),
    },
  });
}

function cors(surface) {
  if (surface === 'web') return { 'Access-Control-Allow-Origin': PAGE_ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate', Vary: 'Origin' };
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version' };
}

// Returns null (no token), { invalid: true }, { accountGone, accountId } (a valid token whose demo
// account has expired or been deleted) or an MCP AuthInfo.
async function authenticate(request, env, resource) {
  const h = request.headers.get('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return { invalid: true };
  const v = await authServer.validateToken(resource, m[1], env);
  if (!v) return { invalid: true };
  const accountId = v.props?.accountId ?? v.userId;
  if (!(await getAccount(env, accountId))) return { accountGone: true, accountId };
  return { token: m[1], clientId: v.clientId, scopes: v.scope, expiresAt: v.expiresAt, resource: new URL(resource), extra: { accountId } };
}

async function revokeGrants(env, userId) {
  try {
    const oauth = authServer.getOAuthApi(env);
    const { items } = await oauth.listUserGrants(userId);
    for (const g of items) await oauth.revokeGrant(g.id, userId);
  } catch {
    logEvent('error', { surface: 'oauth', code: 'grant_revoke_failed' });
  }
}

function callsTool(body, name) {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === 'tools/call' && m.params?.name === name);
}

async function handleMcp(request, env, surface, cid) {
  const t0 = Date.now();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(surface) });
  let auth = await authenticate(request, env, RESOURCES[surface]);
  if (auth?.invalid) {
    logEvent('auth_challenge', { surface, code: 'invalid_token', cid });
    return challenge(surface, 'invalid_token', 'The access token is expired or not for this server');
  }
  // Expired demo account: the estimate keeps working anonymously, and Save asks for a fresh
  // sign-in in each host's own way (HTTP 401 for Claude, the tool error for ChatGPT). The grants
  // are revoked at that point, so a refresh cannot bring back a token for the missing account.
  const gone = auth?.accountGone ? auth.accountId : null;
  const accountGone = !!gone;
  if (accountGone) auth = null;
  let res;
  if (request.method === 'POST') {
    const text = await request.text();
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (accountGone && callsTool(body, 'save_estimate')) {
      logEvent('auth_challenge', { surface, code: 'account_expired', cid });
      await revokeGrants(env, gone);
    }
    if (!auth && surface === 'claude' && callsTool(body, 'save_estimate')) {
      // Claude starts its sign-in prompt only on a transport-level 401 with WWW-Authenticate.
      logEvent('auth_challenge', { surface, code: 'http_401', cid, ms: Date.now() - t0 });
      return accountGone
        ? challenge('claude', 'invalid_token', 'This demo account has expired. Sign in again to save this estimate')
        : challenge('claude', null, 'Sign in to save this estimate');
    }
    if (auth && !auth.scopes.includes(SCOPE) && surface === 'claude' && callsTool(body, 'save_estimate')) {
      return challenge('claude', 'insufficient_scope', 'Saving needs the estimates:write permission', 403);
    }
    const forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: text });
    res = await mcpFor(surface).fetch(forwarded, { authInfo: auth ?? undefined, parsedBody: body });
  } else {
    res = await mcpFor(surface).fetch(request, { authInfo: auth ?? undefined });
  }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors(surface))) out.headers.set(k, v);
  logEvent('mcp_request', { surface, outcome: res.status < 400 ? 'ok' : 'error', code: `http_${res.status}`, cid, ms: Date.now() - t0 });
  return out;
}

async function handleWeb(request, env, path, cid) {
  const t0 = Date.now();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors('web') });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors('web') } });
  if (path === '/api/web/estimate' && request.method === 'POST') {
    let profile;
    try { profile = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const r = await runEstimate(env, profile);
    logEvent('web_estimate', { surface: 'web', outcome: r.status === 'estimated' ? 'ok' : 'refused', ms: Date.now() - t0, cid });
    return json(r);
  }
  if (path === '/api/web/save' && request.method === 'POST') {
    const auth = await authenticate(request, env, RESOURCES.web);
    if (!auth) {
      logEvent('auth_challenge', { surface: 'web', code: 'http_401', cid });
      return challenge('web', null, 'Sign in to save this estimate');
    }
    if (auth.accountGone) await revokeGrants(env, auth.accountId);
    if (auth.invalid || auth.accountGone) {
      logEvent('auth_challenge', { surface: 'web', code: auth.invalid ? 'invalid_token' : 'account_expired', cid });
      return challenge('web', 'invalid_token', auth.invalid ? 'The access token is expired or not for this server' : 'This demo account has expired. Sign in again');
    }
    // The permission is checked before the body is read or anything is written.
    if (!auth.scopes.includes(SCOPE)) {
      logEvent('auth_challenge', { surface: 'web', code: 'insufficient_scope', cid });
      return challenge('web', 'insufficient_scope', 'Saving needs the estimates:write permission', 403);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const s = await saveEstimate(env, { accountId: auth.extra.accountId, estimateId: body?.estimate_id, surface: 'web' });
    logEvent('web_save', { surface: 'web', outcome: s.status === 'saved' ? 'ok' : 'error', code: s.status === 'saved' ? (s.already_saved ? 'already_saved' : 'saved') : s.error, ms: Date.now() - t0, cid });
    const events = s.status === 'saved' ? await serverEventsFor(env, auth.extra.accountId) : [];
    return json({ ...s, server_events_preview: events }, s.status === 'saved' ? 200 : 409);
  }
  return json({ error: 'not_found' }, 404);
}

// Session cookie: account id + HMAC-SHA-256, so a returning visitor can reuse the demo account.
// Checked with crypto.subtle.verify, which compares in constant time.
const hmacKey = (env) => crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(env, value) {
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(value))));
}
async function verify(env, value, sig) {
  let bytes;
  try { bytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sig.length + 3) % 4)), (c) => c.charCodeAt(0)); } catch { return false; }
  if (bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(env), bytes, new TextEncoder().encode(value));
}
async function sessionAccount(request, env) {
  const c = request.headers.get('Cookie') || '';
  const m = new RegExp(`${SESSION_COOKIE}=(acct_[a-z0-9]+)\\.([A-Za-z0-9_-]+)`).exec(c);
  if (!m || !(await verify(env, m[1], m[2]))) return null;
  return getAccount(env, m[1]);
}
async function sessionCookie(env, accountId) {
  return `${SESSION_COOKIE}=${accountId}.${await sign(env, accountId)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`;
}

async function handleAuthorize(request, env, cid) {
  const oauth = authServer.getOAuthApi(env);
  try {
    if (request.method === 'GET') {
      const authReq = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      const acct = await sessionAccount(request, env);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      consent.headers.set('Cache-Control', 'no-store');
      logEvent('oauth_page', { surface: 'oauth', code: `client_${requester(details).kind}`, cid });
      return new Response(authorizePage({ details, handle: consent.handle, existing: acct ? { label: accountLabel(acct.id), hint: maskEmail(acct.email) } : null }), { headers: consent.headers });
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      const action = String(form.get('action') || '');
      if (action === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        denied.headers.set('Location', denied.redirectTo);
        logEvent('oauth_denied', { surface: 'oauth', cid });
        return new Response(null, { status: 302, headers: denied.headers });
      }
      let account = null;
      if (action === 'continue') account = await sessionAccount(request, env);
      const email = String(form.get('email') || '').trim();
      // A mistake on the form brings the form back, with the same handle (not used up yet).
      if (action === 'continue' && !account) return formAgain(request, env, oauth, handle, 'That demo account no longer exists (demo accounts are deleted after 7 days). Create a new one below.', '');
      if (!account && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(email)) {
        return formAgain(request, env, oauth, handle, 'Enter an email address for the demo account, such as you@example.com.', email.slice(0, 254));
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      const details = await oauth.describeConsent(approved.request);
      const via = requester(details).kind;
      if (!account) {
        account = await createAccount(env, email, ['claude', 'chatgpt', 'web'].includes(via) ? via : 'other');
        logEvent('oauth_account', { surface: 'oauth', code: 'created', cid });
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: account.id,
        metadata: { via },
        scope: approved.request.scope?.length ? approved.request.scope : [SCOPE],
        props: { accountId: account.id },
      });
      approved.headers.set('Location', redirectTo);
      approved.headers.append('Set-Cookie', await sessionCookie(env, account.id));
      logEvent('oauth_complete', { surface: 'oauth', cid });
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return errorPage('Unsupported method.', 405);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      logEvent('oauth_error', { surface: 'oauth', code: 'authorize_redirect_error', cid });
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      logEvent('oauth_error', { surface: 'oauth', code: error instanceof CimdFetchError ? 'cimd_fetch' : 'authorize_rejected', cid });
      return errorPage(error instanceof AuthorizationError ? (error.description || 'The sign-in request was not valid.') : 'The app asking to sign in could not be verified.');
    }
    throw error;
  }
}

// The form posts to the authorization URL itself, so the request can be parsed again from it.
async function formAgain(request, env, oauth, handle, error, email) {
  const details = await oauth.describeConsent(await oauth.parseAuthRequest(request));
  const acct = await sessionAccount(request, env);
  logEvent('oauth_page', { surface: 'oauth', code: 'form_error' });
  return new Response(authorizePage({ details, handle, error, email, existing: acct ? { label: accountLabel(acct.id), hint: maskEmail(acct.email) } : null }), {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  });
}

export default {
  fetch(request, env, ctx) {
    return withRequestScope(request, () => route(request, env, ctx));
  },
  async scheduled(event, env, ctx) {
    init(env);
    const ids = await purge(env);
    for (const id of ids) await revokeGrants(env, id);
    await authServer.purgeExpiredData(env).catch(() => {});
    logEvent('purge', { surface: 'cron', outcome: 'ok', code: ids.length ? 'accounts_removed' : 'nothing_to_remove' });
  },
};

async function route(request, env, ctx) {
  {
    const cid = newCorrelationId();
    try {
      init(env);
      const url = new URL(request.url);
      const p = url.pathname;
      if (p === '/mcp/claude' || p === '/mcp/chatgpt') return await handleMcp(request, env, p.slice(5), cid);
      if (p === '/mcp' ) return Response.json({ error: 'Use /mcp/claude or /mcp/chatgpt' }, { status: 404 });
      if (p.startsWith('/api/web/')) return await handleWeb(request, env, p, cid);
      if (p === '/.well-known/oauth-protected-resource/mcp/claude' || p === '/.well-known/oauth-protected-resource') return prm(RESOURCES.claude);
      if (p === '/.well-known/oauth-protected-resource/mcp/chatgpt') return prm(RESOURCES.chatgpt);
      if (p === '/.well-known/oauth-protected-resource/api/web') return prm(RESOURCES.web);
      if (p === '/authorize') return await handleAuthorize(request, env, cid);
      if (p === '/' ) return Response.redirect('https://theaipipe.com/demos/tax-estimate-mcp/', 302);
      if (p === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
      return await authServer.fetch(request, env, ctx);
    } catch (error) {
      logEvent('error', { code: 'unhandled', cid });
      return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
}
