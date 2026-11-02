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
// Each prompt gives every answer the tool requires (it asks rather than assume).
const FILERS = {
  p01: { ...COMMON, filing_status: 'single', w2_wages: 58400, federal_income_tax_withheld: 6050, qualifying_children_under_17: 0,
    prompt: "I'm single, no kids. I expect $58,400 in W-2 wages this year and about $6,050 of federal tax withheld. I'm under 65, not blind, nobody can claim me as a dependent, no other income or situations. What will my federal refund be?" },
  p02: { ...COMMON, ...JOINT, filing_status: 'married_filing_jointly', w2_wages: 128000, federal_income_tax_withheld: 9600, qualifying_children_under_17: 2, children_meet_ctc_rules: true,
    prompt: "We file jointly with two kids, 6 and 9, who live with us all year, are our dependents and, like us, have SSNs valid for work. We're both under 65 and not blind, nobody can claim us as dependents, no other income or situations. Together we'll make $128,000 in W-2 wages this year with $9,600 withheld. Refund or balance due?" },
  p03: { ...COMMON, filing_status: 'head_of_household', head_of_household_confirmed: true, w2_wages: 61500, federal_income_tax_withheld: 4300, qualifying_children_under_17: 1, children_meet_ctc_rules: true,
    prompt: "I file as head of household: I'm unmarried, I pay more than half the cost of our home, and my 10-year-old lives with me all year, is my dependent and, like me, has an SSN valid for work. I'm under 65, not blind, nobody can claim me as a dependent, no other income or situations. $61,500 in wages this year, $4,300 withheld. How much back?" },
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

function promptText() {
  if (!custom) return FILERS[filerId].prompt;
  const p = profile();
  return `${FILERS[filerId].prompt.split('.')[0]}. (Edited: $${p.w2_wages.toLocaleString('en-US')} wages, $${p.federal_income_tax_withheld.toLocaleString('en-US')} withheld.)`;
}

const JTEXT = {};
document.querySelectorAll('#journey li').forEach((li) => { JTEXT[li.dataset.step] = li.querySelector('.j-text').textContent; });
function mark(step, text, label) {
  const li = document.querySelector(`#journey [data-step="${step}"]`);
  if (!li) return;
  li.classList.add('done');
  li.classList.remove('now');
  if (text !== undefined) li.querySelector('.j-time').textContent = text;
  if (label) li.querySelector('.j-text').textContent = label;
}
function resetJourney() {
  document.querySelectorAll('#journey li').forEach((li) => {
    li.classList.remove('done', 'now');
    li.querySelector('.j-time').textContent = '';
    li.querySelector('.j-text').textContent = JTEXT[li.dataset.step];
  });
  $('#events').hidden = true;
}
// Step 1 says "no account" only when no demo account is connected on this page.
const markEstimate = () => mark('estimate', 'no sign-in', token ? 'Estimate shown, no sign-in needed for it' : undefined);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Only the answer to the latest request may reach the card: a slower, older answer is dropped.
let seq = 0;
async function estimate() {
  const mine = ++seq;
  resetJourney();
  $('#prompt-text').textContent = promptText();
  card.showBusy();
  let e;
  try {
    const r = await fetch(`${API}/api/web/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile()) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    e = await r.json();
  } catch {
    if (mine === seq) card.showFailure('The estimate could not be fetched (network or server error).', () => estimate());
    return;
  }
  if (mine !== seq) return;
  card.showEstimate(e);
  if (e.status === 'estimated') markEstimate();
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
    if (!ok) { card.setState('error', { message: 'This browser blocks session storage, which the sign-up redirect needs. Try another browser window.', retry: false }); return; }
    card.setState('saving', { message: 'Opening the sign-up page…' });
    const u = new URL(`${API}/authorize`);
    Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    location.assign(u.toString());
    return;
  }
  if (!again && !resumed) mark('signup', '', 'Using the connected demo account');
  card.setState('saving');
  let r, s;
  try {
    r = await fetch(`${API}/api/web/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ estimate_id: estimateId }) });
    if (r.status === 401 || r.status === 403) { token = null; return save(estimateId, { again: true }); }
    s = await r.json();
  } catch {
    // The request may have reached the server and saved: a retry with the same reference is safe
    // (one record per account and estimate) and tells which it was.
    card.setState('error', { message: 'The save confirmation was interrupted. Try again.' });
    return;
  }
  if (s.status !== 'saved') { card.setState('error', { message: s.message || 'The server did not confirm the save. Try again.' }); return; }
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
  syncEdit();
  if (custom) document.querySelector('.edit').open = true;
  $('#prompt-text').textContent = promptText();
  card.showEstimate(pending.estimate); // exactly the estimate that was on screen
  markEstimate();
  mark('save', '');
  if (q.get('state') !== pending.state || q.get('iss') !== ISSUER) {
    card.setState('error', { message: 'The sign-in response did not match this page, so this estimate is not saved yet. Try again.' });
    return true;
  }
  if (q.has('error')) {
    card.setState('error', { message: q.get('error') === 'access_denied' ? 'Sign-up cancelled. Nothing was saved.' : 'Sign-in failed, so this estimate is not saved yet. Try again.' });
    return true;
  }
  card.setState('saving', { message: 'Account created. Saving…' });
  let t = {}, ok = false;
  try {
    const tr = await fetch(`${API}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: pending.verifier, resource: RESOURCE }),
    });
    t = await tr.json().catch(() => ({}));
    ok = tr.ok && !!t.access_token;
  } catch {}
  if (!ok) { card.setState('error', { message: 'The sign-in could not be completed, so this estimate is not saved yet. Try again to sign in.' }); return true; }
  token = t.access_token;
  mark('signup', journeyStart ? `${secs(Date.now() - journeyStart)} after Save` : '');
  await save(pending.estimate.estimate_id, { again: false, resumed: true });
  return true;
}

document.querySelectorAll('input[name=filer]').forEach((r) => r.addEventListener('change', () => {
  filerId = r.value; custom = null; syncEdit(); estimate();
}));
function syncEdit() {
  const p = profile();
  $('#wages').value = p.w2_wages; $('#withheld').value = p.federal_income_tax_withheld;
  for (const id of ['wages', 'withheld']) fieldError(id, '');
}
function fieldError(id, msg) {
  $(`#${id}-error`).textContent = msg;
  $(`#${id}`).setAttribute('aria-invalid', msg ? 'true' : 'false');
}
// A whole number of dollars, typed explicitly: an empty field is an error, never 0.
function readDollars(id) {
  const raw = $(`#${id}`).value.trim().replace(/[$,\s]/g, '');
  if (raw === '') return { error: 'Enter an amount (0 if none).' };
  if (!/^\d+$/.test(raw)) return { error: 'Whole dollars only, digits only (for example 58400).' };
  const n = Number(raw);
  if (n > 10000000) return { error: 'Up to $10,000,000.' };
  return { value: n };
}
$('#recalc').addEventListener('click', () => {
  const w = readDollars('wages'), h = readDollars('withheld');
  fieldError('wages', w.error || ''); fieldError('withheld', h.error || '');
  if (w.error || h.error) { $(`#${w.error ? 'wages' : 'withheld'}`).focus(); return; }
  custom = { w2_wages: w.value, federal_income_tax_withheld: h.value };
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

// recordings and dated results, all written from data/host-runs.json (filled in by the host tests)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NAME = { chatgpt: 'ChatGPT', claude: 'Claude' };
const lower1 = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const pathText = (t) => String(t || '').replace(/^[A-Z]: /, ''); // drops the HOST_TESTS.md path letter
async function hosts() {
  let runs = null, e2e = null;
  try { runs = await (await fetch('data/host-runs.json', { cache: 'no-store' })).json(); } catch {}
  try { e2e = await (await fetch('data/e2e-production.json', { cache: 'no-store' })).json(); } catch {}
  for (const host of ['claude', 'chatgpt']) {
    const box = document.querySelector(`.rec[data-host=${host}]`);
    const side = document.querySelector(`.result[data-host=${host}]`);
    const h = runs?.[host];
    const filmed = h && (h.status === 'recorded' || h.status === 'pending') && h.video;
    if (!filmed) {
      box.innerHTML = `<p>No ${NAME[host]} recording yet.<br><span class="small">The scripted checks below are what has been verified.</span></p>`;
      side.innerHTML = '';
      continue;
    }
    box.classList.add('has-video');
    box.innerHTML = `<video controls preload="metadata" playsinline ${h.poster ? `poster="${esc(h.poster)}"` : ''} src="${esc(h.video)}"></video>
      <div class="rec-meta"><p class="rec-when">Recorded ${esc(h.date)} on ${esc(h.surface)}.</p>
      <p><span class="rec-k">Edit:</span> ${esc(h.video_note)}</p>
      ${host === 'chatgpt' ? '<p><span class="rec-k">Card label:</span> ChatGPT shows “CSP off” on the card. The card declares its content policy in the MCP Apps key (<code>ui.csp</code>), not yet in ChatGPT\'s own keys (<code>openai/widgetCSP</code>, <code>openai/widgetDomain</code>): left for a pass tested inside ChatGPT.</p>' : ''}
      ${h.repeat_save ? `<p><span class="rec-k">Save again:</span> ${esc(h.repeat_save)}</p>` : ''}</div>`;
    const ok = h.status === 'recorded';
    side.innerHTML = `<h3 class="${ok ? 'r-ok' : 'r-part'}">${ok ? 'Back in the same conversation, saved' : 'Saved, after reopening the conversation'}</h3>
      <p>${esc(ok ? pathText(h.path) : h.why_pending)}</p>
      ${ok ? '' : `<p class="small">${esc(pathText(h.path))}</p>`}
      <p class="small">Tested on a desktop browser only, not on a phone.</p>`;
    $(`#runs-${host}`).innerHTML = (h.runs || []).map((r) => `<li>${esc(r.label)}: <strong>${esc(r.seconds)} s</strong></li>`).join('');
  }
  const items = [];
  if (e2e) {
    const d = new Date(e2e.finished).toLocaleDateString('en-US', { dateStyle: 'medium' });
    items.push(`${d}, scripted MCP client (${esc(e2e.client)}) against the live server: ${e2e.pass} of ${e2e.total} checks passed. Anonymous estimate, HTTP 401 on the Claude endpoint, tool error with a sign-in challenge on the ChatGPT endpoint, account created during OAuth, the same Save resumed, repeated Save returning the same record.`);
  }
  for (const host of ['claude', 'chatgpt']) {
    const h = runs?.[host];
    if (h?.status === 'recorded') items.push(`${esc(h.date)}, ${NAME[host]} on ${esc(h.surface)}: estimate, sign-up and return to the same conversation, filmed.`);
    else if (h?.status === 'pending' && h.video) items.push(`${esc(h.date)}, ${NAME[host]} on ${esc(h.surface)}: estimate, account linking and the saved record, filmed; ${esc(lower1(h.why_pending))}`);
  }
  if (!runs || ['chatgpt', 'claude'].every((x) => runs[x]?.status !== 'recorded')) items.push('Not yet checked: the same journey inside chatgpt.com and claude.ai. The recordings above appear once it is.');
  $('#verified-list').innerHTML = items.map((x) => `<li>${x}</li>`).join('');
}

syncEdit();
hosts();
resumeFromRedirect().then((resumed) => { if (!resumed) estimate(); });
