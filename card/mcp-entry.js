// The card inside ChatGPT and Claude. Talks to the host through the MCP Apps bridge only:
// results arrive as tool-result notifications, Save is a tools/call proxied by the host.
// No token ever reaches this iframe.
import { App } from '@modelcontextprotocol/ext-apps';
import { createCard } from './card-core.js';

const root = document.getElementById('root');
const app = new App({ name: 'tax-estimate-card', version: '0.3.0' }, {}, { autoResize: true });
let hostName = null;

const card = createCard(root, {
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  onSave: save,
  onAskHost: async (estimateId) => {
    card.setState('saving', { message: 'Asked in the conversation. Follow the sign-up step there.' });
    try {
      await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `Save my estimate to my account (estimate reference ${estimateId}).` }] });
    } catch {
      card.setState('error', { message: 'Type "save my estimate" in the conversation to continue.' });
    }
  },
});

function isAuthError(r) {
  return !!(r && r.isError && (r._meta?.['mcp/www_authenticate'] || /sign-in required/i.test(r.content?.[0]?.text || '')));
}

async function save(estimateId) {
  card.setState('saving');
  try {
    const r = await app.callServerTool({ name: 'save_estimate', arguments: { estimate_id: estimateId } });
    if (r.structuredContent?.status === 'saved') return card.setState('saved', { record: r.structuredContent });
    if (isAuthError(r)) return card.setState('signin', { message: 'Saving needs a demo account. Connect one, then press Save again if the card does not update.' });
    card.setState('error', { message: r.structuredContent?.message || r.content?.[0]?.text || 'The estimate was not saved.' });
  } catch {
    // Claude answers an unauthenticated Save with HTTP 401; a host that does not start sign-in from
    // a card call surfaces it here. Asking in the conversation goes through the model path instead.
    card.setState('signin', { message: 'Saving needs a demo account. Connect one, then press Save again if the card does not update.' });
  }
}

app.ontoolinput = () => {};
app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (!sc) return;
  if (sc.status === 'saved') card.showSaved(sc);
  else if (sc.status === 'estimated' || sc.status === 'unsupported_scenario') card.showEstimate(sc);
  else if (sc.status === 'error') card.setState('error', { message: sc.message });
};
app.onhostcontextchanged = (ctx) => { if (ctx?.theme) card.setTheme(ctx.theme); };

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx?.theme) card.setTheme(ctx.theme);
  const v = app.getHostVersion?.();
  hostName = v?.name || null;
}).catch(() => {});
