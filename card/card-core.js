// The estimate card. One component for both places it appears: inside ChatGPT and Claude
// (MCP Apps iframe, see mcp-entry.js) and in the web twin on the demo page (page/site/twin.js).
// It renders what the server returned; it computes nothing and holds no token.

export const CARD_CSS = `
.txc{--tx-paper:#ffffff;--tx-ink:#1c2a35;--tx-muted:#5a6a77;--tx-rule:#d5dde3;--tx-green:#22624a;--tx-green-soft:#e3efe8;--tx-owe:#8d4c12;--tx-owe-soft:#f6ebdf;--tx-blue:#1f4e8c;--tx-blue-ink:#ffffff;--tx-guilloche:#22624a;
  font:15px/1.45 "Public Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--tx-ink);background:var(--tx-paper);
  border:1px solid var(--tx-rule);border-radius:14px;max-width:640px;margin:0 auto;overflow:hidden;font-variant-numeric:tabular-nums}
.txc[aria-busy=true] .txc-num,.txc[aria-busy=true] .txc-lines{opacity:.35;transition:opacity .15s}
.txc-busy{margin:0;padding:12px 18px;font-size:.86rem;color:var(--tx-muted)}
.txc[data-theme=dark]{--tx-paper:#18222a;--tx-ink:#e7eef2;--tx-muted:#a2b2bd;--tx-rule:#2f3f4a;--tx-green:#86c9a8;--tx-green-soft:#1d3229;--tx-owe:#e6a969;--tx-owe-soft:#3a2a1b;--tx-blue:#79a8e6;--tx-blue-ink:#0e1822;--tx-guilloche:#86c9a8}
.txc *{box-sizing:border-box}
.txc-top{position:relative;padding:16px 18px 14px;background:var(--tx-green-soft);overflow:hidden}
.txc[data-outcome=amount_owed] .txc-top{background:var(--tx-owe-soft)}
.txc-top svg{position:absolute;right:-60px;top:-70px;width:250px;height:250px;opacity:.22;pointer-events:none}
.txc-year{margin:0;font-size:.85rem;color:var(--tx-muted);position:relative}
.txc-what{margin:6px 0 0;font-size:1rem;font-weight:600;position:relative}
.txc-num{display:block;margin:2px 0 0;font-size:2.6rem;line-height:1.05;font-weight:800;letter-spacing:-.02em;color:var(--tx-green);position:relative}
.txc[data-outcome=amount_owed] .txc-num{color:var(--tx-owe)}
.txc-lines{list-style:none;margin:0;padding:6px 18px 4px}
.txc-lines li{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--tx-rule)}
.txc-lines li:last-child{border-bottom:none}
.txc-ln{font-size:.72rem;color:var(--tx-muted);white-space:nowrap}
.txc-v{font-weight:600;text-align:right;min-width:6.5ch}
.txc-more{margin:0 18px;border-top:1px solid var(--tx-rule)}
.txc-more summary{cursor:pointer;padding:10px 0;color:var(--tx-blue);font-weight:600;list-style:none}
.txc-more summary::-webkit-details-marker{display:none}
.txc-more summary::after{content:"+";float:right;font-weight:400}
.txc-more[open] summary::after{content:"\\2212"}
.txc-more ol{margin:0 0 10px;padding-left:1.2em;font-size:.86rem}
.txc-more li{margin:0 0 6px}
.txc-src{font-size:.8rem;color:var(--tx-muted);margin:0 0 10px}
.txc-src a{color:var(--tx-blue)}
.txc-draft{font-size:.8rem;margin:0 0 12px;padding:8px 10px;border-left:3px solid var(--tx-owe);background:var(--tx-owe-soft)}
.txc-act{padding:12px 18px 16px}
.txc-btn{font:inherit;font-weight:700;width:100%;padding:12px 14px;border-radius:9px;border:1px solid var(--tx-blue);background:var(--tx-blue);color:var(--tx-blue-ink);cursor:pointer}
.txc-btn[disabled]{opacity:.65;cursor:progress}
.txc-btn.txc-quiet{background:transparent;color:var(--tx-blue);margin-top:8px}
.txc-btn:focus-visible,.txc-more summary:focus-visible{outline:3px solid var(--tx-blue);outline-offset:2px}
.txc-msg{margin:10px 0 0;font-size:.88rem}
.txc-saved{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;padding:12px;border-radius:10px;background:var(--tx-green-soft)}
.txc-saved svg{width:22px;height:22px;color:var(--tx-green);margin-top:1px}
.txc-saved p{margin:0}.txc-saved .txc-sub{font-size:.82rem;color:var(--tx-muted);margin-top:2px}
.txc-fine{margin:0;padding:0 18px 14px;font-size:.75rem;color:var(--tx-muted)}
.txc-refused{padding:16px 18px}
.txc-refused h3{margin:0 0 8px;font-size:1.05rem}
.txc-refused ul{margin:0;padding-left:1.1em;font-size:.88rem}.txc-refused li{margin-bottom:6px}
@media (prefers-reduced-motion:no-preference){.txc-saved{animation:txc-in .35s ease-out}@keyframes txc-in{from{transform:translateY(4px);opacity:0}to{transform:none;opacity:1}}}
`;

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Engraved rosette, the pattern printed on Treasury refund checks, drawn as thin ellipses.
function rosette() {
  let paths = '';
  for (let i = 0; i < 24; i++) {
    paths += `<ellipse cx="125" cy="125" rx="118" ry="46" transform="rotate(${(i * 7.5).toFixed(1)} 125 125)"/>`;
  }
  for (let r = 20; r <= 120; r += 20) paths += `<circle cx="125" cy="125" r="${r}"/>`;
  return `<svg viewBox="0 0 250 250" aria-hidden="true" fill="none" stroke="var(--tx-guilloche)" stroke-width=".6">${paths}</svg>`;
}

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m7.5 12.5 3 3 6-7"/></svg>';

const STATUS_LABEL = { single: 'single', married_filing_jointly: 'married filing jointly', head_of_household: 'head of household' };

function headline(e) {
  if (e.outcome === 'refund') return 'Estimated refund';
  if (e.outcome === 'amount_owed') return 'Estimated amount owed';
  return 'Estimated balance';
}

function linesHtml(L) {
  const rows = [
    ['Taxable income', '15', L.taxable_income_15],
    [L.child_tax_credit_19 ? 'Tax after child tax credit' : 'Federal income tax', '24', L.total_tax_24],
    ['Withheld from pay', '25d', L.federal_withholding_25d],
  ];
  if (L.additional_child_tax_credit_28) rows.push(['Refundable child tax credit', '28', L.additional_child_tax_credit_28]);
  return rows.map(([k, ln, v]) => `<li><span>${k}</span><span class="txc-ln">line ${ln}</span><span class="txc-v">${money(v)}</span></li>`).join('');
}

export function createCard(root, { theme = 'light', hostName = null, onSave, onAskHost } = {}) {
  if (!document.getElementById('txc-style')) {
    const st = document.createElement('style');
    st.id = 'txc-style';
    st.textContent = CARD_CSS;
    document.head.appendChild(st);
  }
  let current = null; // the estimate as returned by the server
  const el = document.createElement('article');
  el.className = 'txc';
  el.dataset.theme = theme;
  el.setAttribute('aria-label', 'Federal tax estimate');
  root.replaceChildren(el);

  function renderEstimate(e) {
    current = e;
    el.removeAttribute('aria-busy');
    el.dataset.outcome = e.outcome || '';
    if (e.status === 'unsupported_scenario') {
      el.innerHTML = `<div class="txc-refused"><p class="txc-year">Tax year ${esc(e.tax_year)}</p><h3>No estimate for this case</h3>
        <ul>${(e.reasons || []).map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul></div>
        <p class="txc-fine">The stand-in engine refuses cases it does not cover rather than guess.</p>`;
      return;
    }
    const status = STATUS_LABEL[e.filing_status] ? `, ${STATUS_LABEL[e.filing_status]}` : '';
    el.innerHTML = `
      <div class="txc-top">${rosette()}
        <p class="txc-year">Federal estimate, tax year ${esc(e.tax_year)}${status}</p>
        <p class="txc-what">${headline(e)}<span class="txc-num" data-testid="amount">${money(e.amount)}</span></p>
      </div>
      <ul class="txc-lines">${linesHtml(e.lines)}</ul>
      <details class="txc-more"><summary>View assumptions</summary>
        ${e.parameters_status === 'draft' ? `<p class="txc-draft">${esc(e.parameters_note)}</p>` : ''}
        <ol>${(e.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
        <p class="txc-src">Sources: ${(e.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join('; ')}. Engine ${esc(e.engine?.version)}.</p>
      </details>
      <div class="txc-act" data-state="idle"><button class="txc-btn" type="button" data-testid="save">Save estimate</button><p class="txc-msg" role="status" aria-live="polite"></p></div>
      <p class="txc-fine">Stand-in engine and sample data for a demo. Not tax advice.</p>`;
    el.querySelector('[data-testid=save]').addEventListener('click', () => onSave && onSave(e.estimate_id));
  }

  const act = () => el.querySelector('.txc-act');

  function setState(state, info = {}) {
    const box = act();
    if (!box) return;
    box.dataset.state = state;
    if (state === 'saving') {
      box.innerHTML = `<button class="txc-btn" type="button" disabled>Saving…</button><p class="txc-msg" role="status" aria-live="polite">${esc(info.message || '')}</p>`;
      return;
    }
    if (state === 'saved') {
      const s = info.record;
      const when = new Date(s.saved_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      box.innerHTML = `<div class="txc-saved" data-testid="saved">${CHECK}<div>
        <p><strong>${s.already_saved ? 'Already saved' : 'Saved'}</strong> to ${esc(s.account.label)}</p>
        <p class="txc-sub">${esc(s.account.email_hint)}, record ${esc(s.record_id)}, ${esc(when)}${info.elapsed ? `. Took ${esc(info.elapsed)} from the click` : ''}</p></div></div>
        ${info.again ? '<button class="txc-btn txc-quiet" type="button" data-testid="save-again">Save again (returns the same record)</button>' : ''}`;
      const again = box.querySelector('[data-testid=save-again]');
      if (again) again.addEventListener('click', () => info.again());
      return;
    }
    if (state === 'signin') {
      box.innerHTML = `<p class="txc-msg" role="status" aria-live="polite" style="margin-top:0">${esc(info.message || 'Saving needs a demo account.')}</p>
        ${onAskHost ? `<button class="txc-btn" type="button" data-testid="ask-host">Ask ${esc(hostName || 'the assistant')} to save it</button>` : ''}`;
      const b = box.querySelector('[data-testid=ask-host]');
      if (b) b.addEventListener('click', () => onAskHost(current.estimate_id));
      return;
    }
    if (state === 'error') {
      box.innerHTML = `<p class="txc-msg" role="alert" style="margin-top:0">${esc(info.message)}</p>${info.retry === false ? '' : '<button class="txc-btn txc-quiet" type="button" data-testid="retry">Try again</button>'}`;
      const retry = box.querySelector('[data-testid=retry]');
      if (retry) retry.addEventListener('click', () => onSave && onSave(current.estimate_id));
      return;
    }
    box.innerHTML = `<button class="txc-btn" type="button" data-testid="save">Save estimate</button><p class="txc-msg" role="status" aria-live="polite"></p>`;
    box.querySelector('[data-testid=save]').addEventListener('click', () => onSave && onSave(current.estimate_id));
  }

  // A save_estimate result can arrive on its own (the host ran the tool after sign-in). It carries
  // the assumptions, sources and engine version, so the card is the same as after the estimate.
  function renderSaved(s) {
    if (!current || current.estimate_id !== s.estimate_id) {
      renderEstimate({ status: 'estimated', estimate_id: s.estimate_id, assumptions: [], sources: [], ...s.estimate });
    }
    setState('saved', { record: s });
  }

  // New inputs are being computed: the card on screen no longer matches them.
  function showBusy(message = 'Computing the estimate…') {
    el.setAttribute('aria-busy', 'true');
    const box = act();
    if (box) {
      box.dataset.state = 'busy';
      box.innerHTML = `<button class="txc-btn" type="button" data-testid="save" disabled>Save estimate</button><p class="txc-msg" role="status" aria-live="polite">${esc(message)}</p>`;
    } else {
      el.innerHTML = `<p class="txc-busy" role="status">${esc(message)}</p>`;
    }
  }

  // The estimate itself could not be fetched: say so, and offer to try again.
  function showFailure(message, onRetry) {
    current = null;
    el.removeAttribute('aria-busy');
    el.dataset.outcome = '';
    el.innerHTML = `<div class="txc-refused"><h3>No estimate yet</h3><p class="txc-msg" role="alert" style="margin-top:0">${esc(message)}</p>
      <button class="txc-btn txc-quiet" type="button" data-testid="retry-estimate">Try again</button></div>`;
    el.querySelector('[data-testid=retry-estimate]').addEventListener('click', () => onRetry && onRetry());
  }

  return {
    showEstimate: renderEstimate,
    showSaved: renderSaved,
    showBusy,
    showFailure,
    setState,
    setTheme: (t) => { el.dataset.theme = t === 'dark' ? 'dark' : 'light'; },
    get estimate() { return current; },
  };
}
