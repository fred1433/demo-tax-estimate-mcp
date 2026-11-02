// Builds page/site/proofs.html from the test outputs (tests/out/*.json), the fixtures and the
// engine. Every number on that page comes from a file or a function, not from hand-typed text.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { estimate } from '../app/src/engine.js';
import { ENGINE } from '../app/src/params.js';

const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = (n) => '$' + Number(n).toLocaleString('en-US');
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

const fx = rd('tests/fixtures/profiles.json');
const ref = rd('tests/fixtures/expected.json');
const e2eProd = rd('tests/out/e2e-production.json');
const e2eLocal = rd('tests/out/e2e-local.json');
const twin = rd('tests/out/twin-production.json');
const privProd = rd('tests/out/privacy-production.json');
const privLocal = rd('tests/out/privacy-local.json');

// unit tests: run them now and keep the counts
const unitOut = execFileSync(process.execPath, ['--test', 'tests/'], { encoding: 'utf8' });
const unit = { pass: Number(/ℹ pass (\d+)/.exec(unitOut)[1]), fail: Number(/ℹ fail (\d+)/.exec(unitOut)[1]) };
const tableRows = (y) => readFileSync(`reference/irs_tax_table_${y}.csv`, 'utf8').trim().split('\n').length - 1;

const STATUS = { single: 'Single', married_filing_jointly: 'Married jointly', head_of_household: 'Head of household' };
const rows = fx.profiles.map((p) => {
  const full = { ...fx.common, ...(p.filing_status === 'married_filing_jointly' ? fx.joint_extra : {}), ...p };
  const r = estimate(full);
  const e = ref.expected[p.id];
  const signed = (x) => (x.outcome === 'amount_owed' ? -x.amount : x.amount);
  const delta = signed(r) - signed(e);
  const credits = r.lines.child_tax_credit_19 + r.lines.additional_child_tax_credit_28;
  return `<tr><td>${esc(p.id)}</td><td>${p.tax_year}</td><td>${STATUS[p.filing_status]}, ${p.qualifying_children_under_17} child${p.qualifying_children_under_17 === 1 ? '' : 'ren'}<br><span class="m">${$(p.w2_wages)} wages, ${$(p.federal_income_tax_withheld)} withheld</span></td>
    <td>${r.lines.tax_method === 'tax_table' ? 'Tax Table' : 'Worksheet'}</td><td>${$(r.lines.taxable_income_15)}</td><td>${$(r.lines.tax_16)}</td><td>${$(credits)}</td>
    <td><strong>${r.outcome === 'refund' ? 'Refund' : 'Owed'} ${$(r.amount)}</strong></td><td>${e.outcome === 'refund' ? 'Refund' : 'Owed'} ${$(e.amount)}</td><td>${delta === 0 ? '$0' : esc(delta)}</td></tr>`;
}).join('\n');

const refusals = fx.refusals.map((p) => {
  const r = estimate({ ...fx.common, ...p });
  return `<li><strong>${esc(p.expect)}</strong>: ${esc(r.reasons.find((x) => x.code === p.expect)?.message)}</li>`;
}).join('\n');

const checks = (run) => (run ? run.results.map((x) => `<li class="${x.ok ? 'ok' : 'ko'}">${x.ok ? 'Pass' : 'Fail'}: ${esc(x.name)}${x.note ? ` <span class="m">(${esc(String(x.note).slice(0, 220))})</span>` : ''}</li>`).join('\n') : '<li>Not run.</li>');

const provenance = (y) => ref.provenance[y];
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tax estimate demo proofs</title><meta name="robots" content="noindex, nofollow">
<link rel="icon" href="favicon.svg" type="image/svg+xml"><link rel="icon" href="favicon.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
<style>
.proofs{max-width:1100px;margin:0 auto;padding:40px 16px 72px}
.proofs h1{font-size:2rem;font-weight:700;line-height:1.15;margin:0 0 12px;letter-spacing:-.01em}
.proofs h2{font-size:1.2rem;margin:40px 0 10px;padding-top:12px;border-top:2px solid var(--ink)}
.proofs p,.proofs li{max-width:78ch;overflow-wrap:anywhere}
.tbl{overflow-x:auto;border:1px solid var(--rule-soft);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:.86rem;min-width:880px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule-soft);vertical-align:top}
th{font-weight:600;color:var(--muted)}
td:nth-child(n+5){text-align:right;white-space:nowrap}
.m{color:var(--muted);font-size:.84em}
ul.checks{padding-left:1.1em;font-size:.9rem}
li.ko{color:var(--owe);font-weight:600}
code{font-size:.82em}
</style></head><body>
<header class="masthead"><div class="wrap mast-row"><a class="brand" href="./"><img src="favicon.svg" alt="" width="22" height="22"> Back to the demo</a><p class="notice">Independent demo · sample tax data. Not affiliated with FileTax.com.</p></div></header>
<main class="proofs">
<h1>What is behind the demo</h1>
<p>Generated from the test outputs on ${day(new Date().toISOString())}. Source code: <a href="https://github.com/fred1433/demo-tax-estimate-mcp">github.com/fred1433/demo-tax-estimate-mcp</a>.</p>

<h2>The journey, checked</h2>
<p><strong>Scripted MCP client</strong> (${esc(e2eProd?.client)}) against the live server, ${e2eProd ? day(e2eProd.finished) : 'not run'}: ${e2eProd ? `${e2eProd.pass} of ${e2eProd.total} checks passed` : ''}. The same script against a local run${e2eLocal ? `: ${e2eLocal.pass} of ${e2eLocal.total}, including the expired-reference case that needs the signing secret` : ''}.</p>
<ul class="checks">${checks(e2eProd)}</ul>
<p><strong>Web twin in a real browser</strong> (${esc(twin?.browser)}), ${twin ? day(twin.at) : 'not run'}: ${twin ? `${twin.pass} of ${twin.total} checks passed` : ''}.</p>
<ul class="checks">${checks(twin)}</ul>
<p><strong>Inside chatgpt.com and claude.ai:</strong> not yet run. The demo page shows those recordings once they exist; nothing here claims them.</p>

<h2>Tax references</h2>
<p>Engine ${esc(ENGINE.version)}, a stand-in kept small on purpose. Expected values come from <code>reference/derive_expected.py</code>, which reads the IRS PDFs (Tax Table rows and Tax Computation Worksheet rows from the text of the publications) and follows Form 1040 and Schedule 8812 by hand, in a different language from the engine. The engine also reproduces every Tax Table row of both years for single, married filing jointly and head of household (${tableRows(2026)} rows for 2026, ${tableRows(2025)} for 2025). Unit tests: ${unit.pass} passed, ${unit.fail} failed.</p>
<p>2026 reference: ${esc(provenance(2026).document)}, <a href="${esc(provenance(2026).url)}">irs.gov</a>, SHA-256 <code>${esc(provenance(2026).sha256.slice(0, 16))}…</code>. It is an IRS draft and can change. 2025 reference: ${esc(provenance(2025).document)}, <a href="${esc(provenance(2025).url)}">irs.gov</a>. Standard deductions, credit amounts and Earned Income Credit limits: Rev. Proc. 2025-32 for 2026; the 2025 Form 1040 and Schedule 8812 instructions for 2025.</p>
<div class="tbl"><table>
<thead><tr><th>Profile</th><th>Year</th><th>Inputs (fictitious)</th><th>Method</th><th>Taxable income</th><th>Tax</th><th>Child credits</th><th>Engine result</th><th>IRS reference (ours)</th><th>Gap</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p><strong>Parity with FileTax engine: to verify after access.</strong> Matching IRS tables is not the same promise as matching FileTax.com's engine to the dollar; that needs its ten reference profiles or its API.</p>
<p>Refused, never estimated (one test each):</p>
<ul>${refusals}</ul>
<p>Line names follow the 2025 Form 1040. Every input is a full-year expected amount. Not computed, so refused: the Earned Income Credit, three or more children, other dependents, 65 or older, blindness, being someone's dependent, Schedule 1-A items (tips, overtime, car loan interest, senior deduction), the 2026 charitable deduction for non-itemizers, self-employment, investment income, itemizing, education, child care, retirement contributions, Marketplace insurance, foreign income, filing separately and wages over $200,000.</p>

<h2>Logs and the Meta event</h2>
<p>The Worker writes one kind of log line: a closed list of fields (event, surface, outcome, duration, a random correlation id, a code). Library output is replaced by a fixed marker. Invocation logs and traces are off. Workers Logs still attach the request URL to each line, so requests whose URL carries a query string (the OAuth authorization request) write no line at all. The page Worker, which receives the OAuth callback, has logging off.</p>
<p><strong>Check on the live Worker</strong>${privProd ? `, ${day(privProd.at)}` : ''}: ${privProd ? `${esc(privProd.steps.length)} steps (estimate, refusal, validation error, sign-in refused, sign-up, Save, repeated Save, tampered reference, invalid token, token refresh, on both endpoints) with recognisable values, then ${esc(privProd.needles_searched)} values searched in ${esc(privProd.worker_log_lines)} lines read back from ${esc(privProd.source)}: <strong>${privProd.hits.length} found</strong>. Fields seen: ${esc(privProd.fields_seen.join(', '))}.` : 'not run.'}</p>
${privLocal ? `<p>Same check on a local run (with the expired-reference case): ${privLocal.hits.length} found in ${privLocal.worker_log_lines} lines.</p>` : ''}
<p>Meta Conversions API: preview only, never sent. After a confirmed sign-up (<code>CompleteRegistration</code>) and a confirmed first Save (<code>Lead</code>), the server stores the event it would send, deduplicated by <code>event_id</code>. It holds a hashed email, a hashed account id, the surface and the action source; no amount, no refund or balance category, no tax year, no IP address or user agent, since on ChatGPT and Claude the request comes from the host's servers, not from the taxpayer. No compliance claim is made.</p>

<h2>OAuth and MCP, as built</h2>
<ul>
<li>Authorization server metadata: <a href="https://tax-mcp-demo.theaipipe.com/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>. Client ID Metadata Documents, PKCE S256 only, RFC 9207 <code>iss</code> on every authorization response, resource indicators bound to one audience per token; Dynamic Client Registration kept for compatibility. Library: <code>@cloudflare/workers-oauth-provider</code> 1.2.4 with the <code>global_fetch_strictly_public</code> flag.</li>
<li>Claude: <code>/mcp/claude</code>. Discovery and the estimate work without a token; an unauthenticated <code>save_estimate</code> gets HTTP 401 with <code>WWW-Authenticate</code> before the MCP layer runs. Card <code>ui.domain</code> computed from the server URL as Claude documents.</li>
<li>ChatGPT: <code>/mcp/chatgpt</code>. <code>securitySchemes</code> per tool (<code>noauth</code> for the estimate, <code>oauth2</code> for Save); an unauthenticated Save returns a tool error carrying <code>_meta["mcp/www_authenticate"]</code>.</li>
<li>Both endpoints serve 2025-era clients (initialize handshake) and 2026-07-28 clients (stateless), through <code>@modelcontextprotocol/server</code> 2.4.0. One MCP Apps card (<code>ui://tax-estimate/card.html</code>, <code>text/html;profile=mcp-app</code>) with the MCP Apps SDK; Save goes through the host bridge and no token reaches the card.</li>
<li>Save: the estimate tool persists nothing (<code>readOnlyHint: true</code>); its reference is signed and expires after 24 hours. Save verifies it, recomputes with the same engine version and refuses if the result would differ. One record per account and estimate: a repeated Save returns the same record. The account comes from the validated token only.</li>
</ul>

<h2>What's left for a real submission</h2>
<ul>
<li>FileTax.com's engine behind the same tool contract, and its ten reference profiles to show parity to the dollar.</li>
<li>FileTax.com's account system as the sign-up and sign-in step, on a FileTax.com domain: Anthropic's review expects the server domain to match the service (<a href="https://claude.com/docs/connectors/building/review-criteria">Claude review criteria</a>).</li>
<li>A sign-in path for an existing account with a password: OpenAI asks for a login and password for a fully featured demo account and rejects plugins whose review needs a new sign-up (<a href="https://developers.openai.com/plugins/plugin-guidelines">plugin guidelines</a>). The demo here only creates accounts.</li>
<li>OpenAI: verified developer identity, plugin ZIP with metadata, domain verification of the MCP host, five positive and three negative test cases, a video walkthrough, support, privacy and terms URLs (<a href="https://developers.openai.com/plugins/deploy/submission">submission guide</a>).</li>
<li>Anthropic: test credentials for a populated account, public documentation, privacy policy and support contact, and carousel screenshots for an MCP App (<a href="https://claude.com/docs/connectors/building/submission">submission guide</a>).</li>
<li>Why this demo is not submitted: it would list an app for FileTax.com's users under someone else's name, and OpenAI does not accept demo plugins (<a href="https://developers.openai.com/plugins/plugin-guidelines">plugin guidelines</a>).</li>
</ul>
</main></body></html>
`;
writeFileSync('page/site/proofs.html', html);
mkdirSync('page/site/data', { recursive: true });
if (e2eProd) copyFileSync('tests/out/e2e-production.json', 'page/site/data/e2e-production.json');
console.log(`proofs.html written; unit ${unit.pass}/${unit.pass + unit.fail}`);
