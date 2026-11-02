// Meta Conversions API adapter, preview only: builds the server event that would be sent after a
// confirmed action, stores it next to the account, and never sends it. Contents are limited on
// purpose: no tax amounts, no refund or balance category, no tax year, no IP address or user agent
// (on ChatGPT and Claude the request comes from the host's servers, not from the taxpayer).
const enc = new TextEncoder();
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EVENT_NAME = { account_created: 'CompleteRegistration', estimate_saved: 'Lead' };

export async function buildServerEvent({ kind, accountId, email, surface, eventKey, now = Date.now() }) {
  const event = {
    event_name: EVENT_NAME[kind],
    event_time: Math.floor(now / 1000),
    event_id: `${kind}_${eventKey}`, // deduplication key with event_name: one per account or per saved record
    action_source: surface === 'web' ? 'website' : 'chat',
    user_data: {
      em: [await sha256Hex(String(email).trim().toLowerCase())],
      external_id: [await sha256Hex(accountId)],
    },
    custom_data: { surface },
  };
  if (surface === 'web') event.event_source_url = 'https://theaipipe.com/demos/tax-estimate-mcp/';
  return {
    status: 'preview_not_sent',
    endpoint: 'POST https://graph.facebook.com/{api_version}/{pixel_id}/events (not called)',
    event_id: event.event_id,
    payload: { data: [event] },
    left_out: ['tax amounts', 'refund or amount-owed category', 'tax year and filing details', 'client_ip_address and client_user_agent'],
  };
}
