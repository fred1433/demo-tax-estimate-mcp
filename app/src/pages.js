// Sign-up and consent page of the demo authorization server, plus its error page.
// Everything that comes from the OAuth client (name, domain, redirect host, scopes) is escaped.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const KNOWN = {
  'claude.ai': ['Claude', 'claude'],
  'claude.com': ['Claude', 'claude'],
  'chatgpt.com': ['ChatGPT', 'chatgpt'],
  'openai.com': ['ChatGPT', 'chatgpt'],
  'theaipipe.com': ['The web estimator', 'web'],
};

export function requester(details) {
  if (details.clientDomain) {
    const host = details.clientDomain.toLowerCase();
    const known = Object.entries(KNOWN).find(([d]) => host === d || host.endsWith('.' + d));
    return { name: known ? known[1][0] : details.clientDomain, verified: true, domain: details.clientDomain, kind: known ? known[1][1] : 'other' };
  }
  return { name: details.clientName, verified: false, domain: null, kind: 'other' };
}

const STYLE = `
:root{--paper:#f2f5f3;--card:#fff;--ink:#1c2a35;--muted:#566673;--rule:#c9d3da;--blue:#1f4e8c;--blue-ink:#fff;--green:#2f6b4f;--warn:#8a4b0f;}
@media (prefers-color-scheme:dark){:root{--paper:#121a20;--card:#18222a;--ink:#e6edf1;--muted:#9fb0bc;--rule:#2e3d48;--blue:#6ea0e0;--blue-ink:#0d1620;--green:#7cc3a0;--warn:#e0a463;}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 "Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:30rem;margin:0 auto;padding:28px 16px 40px}
.who{font-size:.85rem;color:var(--muted);margin:0 0 18px}
h1{font-size:1.55rem;line-height:1.2;margin:0 0 10px;font-weight:700;letter-spacing:-.01em}
p{margin:0 0 14px}
.panel{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:18px 16px;margin:18px 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:.92rem}dt{color:var(--muted)}dd{margin:0;font-weight:600;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:4px 0 6px}
input[type=email]{width:100%;font:inherit;padding:12px;border:1px solid var(--rule);border-radius:8px;background:var(--paper);color:var(--ink)}
input:focus-visible,button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
.hint{font-size:.85rem;color:var(--muted);margin:6px 0 0}
button{font:inherit;font-weight:700;border-radius:8px;padding:13px 16px;width:100%;cursor:pointer;border:1px solid var(--blue)}
.primary{background:var(--blue);color:var(--blue-ink)}.secondary{background:transparent;color:var(--blue);margin-top:10px}
.deny{background:transparent;border:none;color:var(--muted);text-decoration:underline;width:auto;padding:8px 0;margin-top:8px;font-weight:500}
.warn{color:var(--warn);font-weight:600}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.85rem;margin:16px 0 10px}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--rule)}
footer{font-size:.8rem;color:var(--muted);margin-top:22px}
`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="icon" href="https://theaipipe.com/favicon.svg"><style>${STYLE}</style></head><body><main>${body}
<footer>The AI Pipe demo service. Independent demo with sample tax data, not affiliated with FileTax.com. Demo accounts and saved estimates are deleted after 7 days.</footer></main></body></html>`;
}

export function authorizePage({ details, handle, existing }) {
  const who = requester(details);
  const scopes = details.scope.length ? details.scope : ['estimates:write'];
  const scopeText = scopes.map((s) => (s === 'estimates:write' ? 'Save tax estimates to this demo account' : esc(s))).join(', ');
  const appLine = who.verified
    ? `<dd>${esc(who.name)}${who.domain && who.name !== who.domain ? ` (${esc(who.domain)})` : ''}</dd>`
    : `<dd>${esc(who.name)} <span class="warn">(name not verified: this app registered itself)</span></dd>`;
  const existingBlock = existing ? `
  <form method="post" class="panel">
    <input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="action" value="continue">
    <p>You already have a demo account in this browser: <strong>${esc(existing.label)}</strong> (${esc(existing.hint)}).</p>
    <button class="primary" type="submit">Continue with ${esc(existing.label)}</button>
  </form>
  <div class="or">or</div>` : '';
  return shell('Create a demo account', `
  <p class="who">The AI Pipe demo service</p>
  <h1>${existing ? 'Save your estimate' : 'Create a demo account to save your estimate'}</h1>
  <p>${esc(who.name)} is asking to save tax estimates to an account on this demo service. After you continue, you go straight back to where you were.</p>
  <div class="panel"><dl>
    <dt>App asking</dt>${appLine}
    <dt>Sends access to</dt><dd>${esc(details.redirectHost)}</dd>
    <dt>Permission</dt><dd>${scopeText}</dd>
  </dl>${details.redirectIsLoopback ? '<p class="warn" style="margin-top:12px">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>' : ''}</div>
  ${existingBlock}
  <form method="post" class="${existing ? 'panel' : ''}">
    <input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="action" value="create">
    <label for="email">Email for the demo account</label>
    <input id="email" name="email" type="email" required autocomplete="email" inputmode="email" placeholder="you@example.com">
    <p class="hint">Not verified and never emailed. This is a temporary demo account, so there is no password or code to check: real sign-up at FileTax.com would add those steps.</p>
    <p style="margin-top:14px"><button class="${existing ? 'secondary' : 'primary'}" type="submit">Create account and save</button></p>
  </form>
  <form method="post"><input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="action" value="deny"><button class="deny" type="submit">Cancel and go back without saving</button></form>`);
}

export function errorPage(message, status = 400) {
  return new Response(shell('Sign-in problem', `<p class="who">The AI Pipe demo service</p><h1>This sign-in link can't be used</h1><p>${esc(message)}</p><p>Go back to the conversation and press Save again to start a fresh sign-in.</p>`), {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  });
}
