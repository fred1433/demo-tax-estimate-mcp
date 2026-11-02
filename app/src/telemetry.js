// Closed-list telemetry. Every line this Worker writes to its logs goes through logEvent(), which
// accepts only the fields and values listed here. Tool arguments, results, profiles, tokens,
// OAuth parameters, emails and error messages are never passed in, so they cannot be logged.
// Output from libraries (console.log/warn/error) is replaced by a fixed marker.
//
// Workers Logs attach the request URL to every log line of an invocation, query string included,
// even with invocation logs off. So a request whose URL carries a query string (the OAuth
// authorization request: client_id, state, code_challenge, redirect_uri) writes no log line at all.
import { AsyncLocalStorage } from 'node:async_hooks';

const requestScope = new AsyncLocalStorage();
const raw = console.log.bind(console);
const quiet = () => requestScope.getStore()?.quiet === true;
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = () => { if (!quiet()) raw(JSON.stringify({ evt: 'lib_log_suppressed', level })); };
}

export function withRequestScope(request, fn) {
  return requestScope.run({ quiet: new URL(request.url).search !== '' }, fn);
}

export const EVENTS = new Set([
  'mcp_request', 'auth_challenge', 'tool_estimate', 'tool_save', 'web_estimate', 'web_save',
  'oauth_page', 'oauth_account', 'oauth_complete', 'oauth_denied', 'oauth_error',
  'server_event_preview', 'error', 'purge',
]);
export const SURFACES = new Set(['claude', 'chatgpt', 'web', 'oauth', 'cron']);
const OUTCOMES = new Set(['ok', 'refused', 'error']);
const CODE = /^[a-z][a-z0-9_]{0,47}$/;

export function newCorrelationId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// fields: { surface, outcome, ms, cid, code }
export function sanitizeEvent(evt, fields = {}) {
  if (!EVENTS.has(evt)) evt = 'error';
  const out = { evt };
  if (SURFACES.has(fields.surface)) out.surface = fields.surface;
  if (OUTCOMES.has(fields.outcome)) out.outcome = fields.outcome;
  if (Number.isFinite(fields.ms) && fields.ms >= 0 && fields.ms < 600000) out.ms = Math.round(fields.ms);
  if (typeof fields.cid === 'string' && /^[0-9a-f]{12}$/.test(fields.cid)) out.cid = fields.cid;
  if (typeof fields.code === 'string') out.code = CODE.test(fields.code) ? fields.code : 'other';
  return out;
}

export function logEvent(evt, fields) {
  if (quiet()) return;
  raw(JSON.stringify(sanitizeEvent(evt, fields)));
}
