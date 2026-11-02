# Host tests: ChatGPT and Claude

What the builder could not do: run the journey inside chatgpt.com and claude.ai. Everything below is
for whoever runs those tests in a logged-in browser. Record what really happens, including failures
and slow runs. Nothing on the page claims a host run until `page/site/data/host-runs.json` says so.

Server URLs (fixed, do not change them between runs):

- Claude: `https://tax-mcp-demo.theaipipe.com/mcp/claude`
- ChatGPT: `https://tax-mcp-demo.theaipipe.com/mcp/chatgpt`

Sample prompt (same as the page's first filer):

> I'm single, no kids. I expect $58,400 in W-2 wages this year and about $6,050 of federal tax withheld. What will my federal refund be?

Expected card: tax year 2026, estimated refund **$1,219**, taxable income $42,300, federal income tax $4,831, withheld $6,050.
If the model asks follow-up questions (65 or older, blind, dependent, other situations), answer no / none: the
tool requires those answers on purpose.

## Claude (claude.ai, desktop browser)

1. Add the connector: open
   `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Tax%20estimate%20demo&connectorUrl=https%3A%2F%2Ftax-mcp-demo.theaipipe.com%2Fmcp%2Fclaude`
   and confirm. Claude should connect without asking to sign in (tools are listed anonymously).
   If Claude asks to sign in at this step, note it: it means Claude treats the server as auth-required.
2. New chat, enable the connector, paste the sample prompt.
   Check: `estimate_federal_tax` runs without sign-in; the card renders (Claude may ask to allow the app UI).
3. Start the stopwatch, then press **Save estimate** on the card.
   - Expected path A: Claude shows its inline **Connect** card (the server answered HTTP 401). Click it.
   - Path B: the card shows "Saving needs a demo account" with **Ask Claude to save it**. Click that; Claude calls
     `save_estimate`, gets the 401 and shows **Connect**. Note which path happened: it tells whether Claude
     starts sign-in from a call made by the card itself.
4. In the popup: the page title is "Create a demo account to save your estimate", "App asking" should read
   **Claude (claude.ai)**. Type any email, press **Create account and save**.
5. Stop the stopwatch when the conversation shows the saved state ("Saved to Demo account XXXX", record `sav_…`).
   Check it is the same conversation, and that Claude retried the same Save without you typing anything.
6. Press Save again (or ask "save it again"): expect "Already saved" with the same record id.
7. Repeat steps 2 to 5 twice more in fresh chats, signed out of the demo service first (use a private window
   for the popup or clear cookies for `tax-mcp-demo.theaipipe.com`), to get cold timings. Keep every timing.

## ChatGPT (chatgpt.com, desktop browser)

1. Open https://chatgpt.com/plugins, select the plus button, then **Add custom MCP server**.
   Name: Tax estimate demo. Server URL: `https://tax-mcp-demo.theaipipe.com/mcp/chatgpt`.
   Authentication: **OAuth or no authentication** (mixed). Accept the warning, create, install.
   Note what the management page shows for the redirect URI and client registration (CIMD or DCR).
   The server advertises RFC 9207 `iss`, so ChatGPT should use `https://chatgpt.com/connector_platform_oauth_redirect`
   and its CIMD `https://chatgpt.com/oauth/client.json`. The authorization server accepts any compliant redirect
   listed in the client's CIMD document or DCR registration; nothing to allowlist by hand.
2. New chat, `@Tax estimate demo`, paste the sample prompt. Expect the card with $1,219 and no sign-in.
3. Stopwatch, then **Save estimate** on the card (or ask "save this estimate"). The server answers the
   unauthenticated Save with a tool error carrying `_meta["mcp/www_authenticate"]`; ChatGPT should show its
   account-linking UI. Note whether it appears from the card button, from the model's call, or neither.
4. Sign-up page: "App asking" should read **ChatGPT (chatgpt.com)**. Create the account.
5. Stop when the saved state is shown in the same conversation. Note whether ChatGPT retried the Save by itself
   or whether you had to ask again.
6. Repeat Save: "Already saved", same record. Then two more cold runs as above.

## What to record

- Screen recordings (desktop, browser named exactly, e.g. "Chrome 1xx on macOS, chatgpt.com web"); no phone
  claims unless a phone was really used. Save them as:
  - `page/site/recordings/chatgpt.mp4` (+ `chatgpt.jpg` poster)
  - `page/site/recordings/claude.mp4` (+ `claude.jpg` poster)
- Fill `page/site/data/host-runs.json`, one block per host:

```json
"claude": {
  "status": "recorded",
  "surface": "claude.ai in Chrome on macOS (desktop)",
  "date": "Nov 3, 2026",
  "video": "recordings/claude.mp4",
  "poster": "recordings/claude.jpg",
  "runs": [
    { "label": "Run 1, new demo account", "seconds": 0 },
    { "label": "Run 2, new demo account", "seconds": 0 },
    { "label": "Run 3, new demo account", "seconds": 0 }
  ]
}
```

  Keep `"status": "pending"` for a host that was not run or that failed, and write what failed in the session notes.
- Then redeploy the page (`cd page && npx wrangler deploy`) and purge the cache of
  `https://theaipipe.com/demos/tax-estimate-mcp/` and `https://theaipipe.com/demos/tax-estimate-mcp/data/host-runs.json`.

## Server-side checks after a host run (optional)

- D1: `npx wrangler d1 execute tax-mcp-demo --remote --command "SELECT surface, count(*) FROM saves GROUP BY surface"`
  (from `app/`) shows saves per surface; `server_events` holds the Meta previews.
- Workers Logs: only closed-list events (`evt`, `surface`, `outcome`, `ms`, `cid`, `code`).
- If a host fails at sign-in, `oauth_error` events carry the library's error code (no parameters).
