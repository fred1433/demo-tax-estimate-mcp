# Tax estimate app for ChatGPT and Claude (independent demo)

A remote MCP server with two tools, built for FileTax.com as an independent demo (not affiliated with FileTax.com, sample tax data only):

- `estimate_federal_tax`: no sign-in. Formal JSON Schemas, `readOnlyHint: true`, a result card (MCP Apps) and a plain-text fallback.
- `save_estimate`: OAuth 2.1. An account is created on the sign-up page during authorization and the estimate shown is stored once per account (a repeated Save returns the same record). A token whose demo account has expired gets each host's sign-in challenge again. Tested on Nov 2, 2026: Claude resumed the same Save by itself in the same conversation; ChatGPT linked the account but came back to its home page, so the conversation had to be reopened and Save pressed again (HOST_TESTS.md).

Live: page https://theaipipe.com/demos/tax-estimate-mcp/ and server https://tax-mcp-demo.theaipipe.com (`/mcp/claude`, `/mcp/chatgpt`).

## Layout

| Path | What |
| --- | --- |
| `app/src/engine.js`, `app/src/params.js` | Stand-in tax engine (2026 default, 2025), every parameter with its IRS source. Refuses what it does not compute. |
| `app/src/mcp.js` | Tools, schemas, annotations, card resource; per-host metadata (`securitySchemes` and the `mcp/www_authenticate` tool error for ChatGPT, `ui.domain` for Claude). |
| `app/src/index.js` | Routing, HTTP 401 gate for Claude, token validation, sign-up and consent, web twin API. |
| `app/src/telemetry.js` | Closed-list log events; no output from requests whose URL carries a query string. |
| `app/src/core.js`, `app/src/estimate-id.js`, `app/src/meta.js` | Save with idempotency, signed estimate references, Meta Conversions API preview (never sent). |
| `card/` | The result card, shared by the MCP App and the web twin. |
| `page/site/` | Demo page, web twin (an OAuth client identified by its CIMD document), proofs page. |
| `reference/derive_expected.py` | Expected results derived from the IRS PDFs, independently of the engine. |
| `tests/` | Unit tests, real MCP client end-to-end, privacy canary on real logs, Playwright test of the twin. |
| `HOST_TESTS.md` | What to click and measure in chatgpt.com and claude.ai. |

## Run the checks

```sh
npm install
npm test                                                     # engine against every IRS Tax Table row, 14 profiles, refusals, units
python3 reference/derive_expected.py                         # rebuild the IRS reference (needs pdftotext)
node tests/e2e_mcp_client.mjs https://tax-mcp-demo.theaipipe.com
node tests/e2e_mcp_client.mjs http://127.0.0.1:8787 --secret <ESTIMATE_SECRET> --local-d1   # local: adds expired-account and event-repair cases
python3 tests/twin_playwright.py https://theaipipe.com/demos/tax-estimate-mcp/
python3 tests/twin_fixes.py https://theaipipe.com/demos/tax-estimate-mcp/ [--site page/site]  # page faults: late answer, lost Save response, empty fields
CLOUDFLARE_ACCOUNT_ID=... node tests/privacy_canary.mjs https://tax-mcp-demo.theaipipe.com --cf
node scripts/build-proofs.mjs                                # regenerates page/site/proofs.html from tests/out
```

Local server: `cd app && npx wrangler dev --ip 127.0.0.1 --port 8787 --local --local-upstream 127.0.0.1:8787` with `ORIGIN`, `PAGE_ORIGIN`, `SESSION_SECRET` and `ESTIMATE_SECRET` in `app/.dev.vars`.

No model API is called at run time. Built by Frederic de Lavenne de Choulot, The AI Pipe.
