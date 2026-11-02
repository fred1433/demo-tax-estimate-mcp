// Web twin: the same card, the same server calculation and the same Save through the same OAuth
// authorization server as the ChatGPT and Claude app. This page is an OAuth public client
// identified by a Client ID Metadata Document (oauth-client.json), with PKCE S256.
import { createCard } from './card-core.js';

const API = 'https://tax-mcp-demo.theaipipe.com';
const ISSUER = API;
const CLIENT_ID = 'https://theaipipe.com/demos/tax-estimate-mcp/oauth-client.json';
const REDIRECT = 'https://theaipipe.com/demos/tax-estimate-mcp/';
const RESOURCE = `${API}/api/web`;
const SCOPE = 'estimates:write';
const KEY = 'taxdemo.pending';

const COMMON = { tax_year: 2026, other_dependents: 0, taxpayer_age_65_or_older: false, taxpayer_blind: false, can_be_claimed_as_dependent: false, other_situations: ['none'] };
const JOINT = { spouse_age_65_or_older: false, spouse_blind: false };
const FILERS = {
  p01: { ...COMMON, filing_status: 'single', w2_wages: 58400, federal_income_tax_withheld: 6050, qualifying_children_under_17: 0,
    prompt: "I'm single, no kids. I expect $58,400 in W-2 wages this year and about $6,050 of federal tax withheld. What will my federal refund be?" },
  p02: { ...COMMON, ...JOINT, filing_status: 'married_filing_jointly', w2_wages: 128000, federal_income_tax_withheld: 9600, qualifying_children_under_17: 2, children_meet_ctc_rules: true,
    prompt: "We file jointly with two kids, 6 and 9. Together we'll make $128,000 in W-2 wages this year with $9,600 withheld. Refund or balance due?" },
  p03: { ...COMMON, filing_status: 'head_of_household', head_of_household_confirmed: true, w2_wages: 61500, federal_income_tax_withheld: 4300, qualifying_children_under_17: 1, children_meet_ctc_rules: true,
    prompt: "I file as head of household with my 10-year-old. $61,500 in wages this year, $4,300 withheld. How much back?" },
};

const $ = (s) => document.querySelector(s);
const store = {
  get() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); return true; } catch { return false; } },
  clear() { try { sessionStorage.removeItem(KEY); } catch {} },
};
let token = null; // in memory only
let filerId = 'p01';
let custom = null;
let journeyStart = null;

const card = createCard($('#card'), {
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  onSave: (id) => save(id),
});

function profile() {
  const { prompt, ...p } = FILERS[filerId];
  return custom ? { ...p, ...custom } : p;
}

function mark(step, text) {
  const li = document.querySelector(`#journey [data-step="${step}"]`);
  if (!li) return;
  li.classList.add('done');
  li.classList.remove('now');
  if (text) li.querySelector('.j-time').textContent = text;
}
function resetJourney() {
  document.querySelectorAll('#journey li').forEach((li) => { li.classList.remove('done', 'now'); li.querySelector('.j-time').textContent = ''; });
  $('#events').hidden = true;
}
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function estimate() {
  resetJourney();
  $('#prompt-text').textContent = custom ? `${FILERS[filerId].prompt.split('.')[0]}. (Edited: $${profile().w2_wages.toLocaleString('en-US')} wages, $${profile().federal_income_tax_withheld.toLocaleString('en-US')} withheld.)` : FILERS[filerId].prompt;
  const r = await fetch(`${API}/api/web/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile()) });
  const e = await r.json();
  card.showEstimate(e);
  if (e.status === 'estimated') mark('estimate', 'no sign-in');
}

function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function save(estimateId, { again = false, resumed = false } = {}) {
  if (!again && !resumed) { journeyStart = Date.now(); mark('save', ''); }
  if (!token) {
    const { verifier, challenge } = await pkce();
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const ok = store.set({ state, verifier, estimate: card.estimate, filerId, custom, startedAt: journeyStart });
    if (!ok) { card.setState('error', { message: 'This browser blocks session storage, which the sign-up redirect needs. Try another browser window.' }); return; }
    card.setState('saving', { message: 'Opening the sign-up page…' });
    const u = new URL(`${API}/authorize`);
    Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    location.assign(u.toString());
    return;
  }
  card.setState('saving');
  const r = await fetch(`${API}/api/web/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ estimate_id: estimateId }) });
  if (r.status === 401) { token = null; return save(estimateId, { again: true }); }
  const s = await r.json();
  if (s.status !== 'saved') { card.setState('error', { message: s.message || 'The estimate was not saved.' }); return; }
  const elapsed = journeyStart ? Date.now() - journeyStart : null;
  card.setState('saved', { record: s, elapsed: !again && elapsed ? secs(elapsed) : null, again: () => save(estimateId, { again: true }) });
  if (!again) mark('saved', elapsed ? `${secs(elapsed)} after Save` : '');
  if (s.server_events_preview?.length) {
    $('#events-json').textContent = JSON.stringify(s.server_events_preview, null, 2);
    $('#events').hidden = false;
  }
}

async function resumeFromRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  const pending = store.get();
  store.clear();
  history.replaceState(null, '', location.pathname); // the code leaves the address bar at once
  if (!pending) { await estimate(); return true; }
  filerId = pending.filerId; custom = pending.custom; journeyStart = pending.startedAt;
  document.querySelector(`input[name=filer][value=${filerId}]`).checked = true;
  $('#prompt-text').textContent = FILERS[filerId].prompt;
  card.showEstimate(pending.estimate); // exactly the estimate that was on screen
  mark('estimate', 'no sign-in');
  mark('save', '');
  if (q.get('state') !== pending.state || q.get('iss') !== ISSUER) {
    card.setState('error', { message: 'The sign-in response did not match this page. Nothing was saved.' });
    return true;
  }
  if (q.has('error')) {
    card.setState('error', { message: q.get('error') === 'access_denied' ? 'Sign-up cancelled. Nothing was saved.' : 'Sign-in failed. Nothing was saved.' });
    return true;
  }
  card.setState('saving', { message: 'Account created. Saving…' });
  const tr = await fetch(`${API}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: pending.verifier, resource: RESOURCE }),
  });
  const t = await tr.json().catch(() => ({}));
  if (!tr.ok || !t.access_token) { card.setState('error', { message: 'The sign-in could not be completed. Nothing was saved.' }); return true; }
  token = t.access_token;
  mark('signup', journeyStart ? `${secs(Date.now() - journeyStart)} after Save` : '');
  await save(pending.estimate.estimate_id, { again: false, resumed: true });
  return true;
}

document.querySelectorAll('input[name=filer]').forEach((r) => r.addEventListener('change', () => {
  filerId = r.value; custom = null; syncEdit(); estimate();
}));
function syncEdit() { const p = profile(); $('#wages').value = p.w2_wages; $('#withheld').value = p.federal_income_tax_withheld; }
$('#recalc').addEventListener('click', () => {
  const w = parseInt($('#wages').value, 10), h = parseInt($('#withheld').value, 10);
  custom = { w2_wages: Number.isFinite(w) ? w : 0, federal_income_tax_withheld: Number.isFinite(h) ? h : 0 };
  estimate();
});

// host tabs
const tabs = [...document.querySelectorAll('[role=tab]')];
tabs.forEach((t) => t.addEventListener('click', () => select(t)));
tabs.forEach((t, i) => t.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; select(n); n.focus(); } }));
function select(t) {
  tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute('aria-controls')).hidden = !on; });
}
document.querySelectorAll('.copy').forEach((c) => c.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(c.dataset.copy); const o = c.textContent; c.textContent = 'Copied'; setTimeout(() => { c.textContent = o; }, 1200); } catch {}
}));

// recordings and dated results, filled in by the host tests
async function hosts() {
  let runs = null, e2e = null;
  try { runs = await (await fetch('data/host-runs.json', { cache: 'no-store' })).json(); } catch {}
  try { e2e = await (await fetch('data/e2e-production.json', { cache: 'no-store' })).json(); } catch {}
  for (const host of ['chatgpt', 'claude']) {
    const box = document.querySelector(`.rec[data-host=${host}]`);
    const h = runs?.[host];
    const name = host === 'chatgpt' ? 'ChatGPT' : 'Claude';
    if (h && h.status === 'recorded' && h.video) {
      const times = (h.runs || []).map((r) => `<li>${r.label}: ${r.seconds} s from Save to saved</li>`).join('');
      box.innerHTML = `<video controls preload="metadata" playsinline ${h.poster ? `poster="${h.poster}"` : ''} src="${h.video}"></video>
        <div class="rec-meta">Recorded ${h.date} in ${name} on ${h.surface}.${times ? `<ul>${times}</ul>` : ''}</div>`;
    } else if (h && h.status === 'pending' && h.video) {
      const times = (h.runs || []).map((r) => `<li>${r.label}: ${r.seconds} s from Save to saved</li>`).join('');
      box.innerHTML = `<video controls preload="metadata" playsinline ${h.poster ? `poster="${h.poster}"` : ''} src="${h.video}"></video>
        <div class="rec-meta">Recorded ${h.date} in ${name} on ${h.surface}. Not yet seamless: ${h.why_pending.charAt(0).toLowerCase() + h.why_pending.slice(1)}${times ? `<ul>${times}</ul>` : ''}</div>`;
    } else {
      box.innerHTML = `<p>No ${name} recording yet.<br><span class="small">The scripted checks below are what has been verified.</span></p>`;
    }
  }
  const list = $('#verified-list');
  const items = [];
  if (e2e) {
    const d = new Date(e2e.finished).toLocaleDateString('en-US', { dateStyle: 'medium' });
    items.push(`${d}, scripted MCP client (${e2e.client}) against the live server: ${e2e.pass} of ${e2e.total} checks passed. Anonymous estimate, HTTP 401 on the Claude endpoint, tool error with a sign-in challenge on the ChatGPT endpoint, account created during OAuth, the same Save resumed, repeated Save returning the same record.`);
  }
  for (const host of ['chatgpt', 'claude']) {
    const h = runs?.[host];
    if (h?.status === 'recorded') items.push(`${h.date}, ${host === 'chatgpt' ? 'ChatGPT' : 'Claude'} on ${h.surface}: estimate, sign-up and return to the same conversation, filmed.`);
    else if (h?.status === 'pending' && h.video) items.push(`${h.date}, ${host === 'chatgpt' ? 'ChatGPT' : 'Claude'} on ${h.surface}: estimate, account linking and the saved record, filmed; the conversation had to be reopened after sign-up.`);
  }
  if (!runs || ['chatgpt', 'claude'].every((h) => runs[h]?.status !== 'recorded')) items.push('Not yet checked: the same journey inside chatgpt.com and claude.ai. The recordings above appear once it is.');
  list.innerHTML = items.map((x) => `<li>${x}</li>`).join('');
}

syncEdit();
hosts();
resumeFromRedirect().then((resumed) => { if (!resumed) estimate(); });
