// MCP server: two tools and one MCP Apps card, served at /mcp/claude and /mcp/chatgpt.
// Both endpoints expose the same operations; only the sign-in signal and a few host-specific
// metadata keys differ.
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { runEstimate, saveEstimate, estimateText, saveText } from './core.js';
import { OTHER_SITUATIONS } from './params.js';
import { FILING_STATUSES } from './engine.js';
import { logEvent } from './telemetry.js';
import CARD_HTML from './card.generated.js';

export const CARD_URI = 'ui://tax-estimate/card.html';
export const SCOPE = 'estimates:write';

const money = { type: 'integer', minimum: 0, maximum: 10000000 };

export const ESTIMATE_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['filing_status', 'w2_wages', 'federal_income_tax_withheld', 'qualifying_children_under_17', 'other_dependents', 'taxpayer_age_65_or_older', 'taxpayer_blind', 'can_be_claimed_as_dependent', 'other_situations'],
  properties: {
    tax_year: { type: 'integer', enum: [2026, 2025], default: 2026, description: 'Tax year. 2026 (filed in 2027) unless the user asks about 2025.' },
    filing_status: { type: 'string', enum: FILING_STATUSES, description: 'Filing status as the user states it. Do not infer head of household from having a child.' },
    head_of_household_confirmed: { type: 'boolean', description: 'Only for head_of_household: true when the user confirms being unmarried (or considered unmarried), paying more than half the cost of keeping up a home, with a qualifying person living there.' },
    w2_wages: { ...money, description: 'Expected W-2 wages (box 1) for the FULL year, both spouses if filing jointly, in whole dollars. Not a year-to-date figure.' },
    federal_income_tax_withheld: { ...money, description: 'Expected federal income tax withheld (W-2 box 2) for the FULL year. Not Social Security or Medicare.' },
    qualifying_children_under_17: { type: 'integer', minimum: 0, maximum: 10, description: 'Children who will be under 17 at the end of the year and are claimed as dependents. 0 if none.' },
    children_meet_ctc_rules: { type: 'boolean', description: 'Required when there are children: true when the user confirms each child lived with them more than half the year, is their dependent and has an SSN valid for employment, and that the user (or one spouse on a joint return) has a valid SSN. Never ask for the numbers themselves.' },
    other_dependents: { type: 'integer', minimum: 0, maximum: 10, description: 'Other dependents (for example a child 17 or older, a parent). 0 if none.' },
    taxpayer_age_65_or_older: { type: 'boolean', description: 'Will the taxpayer be 65 or older at the end of the year?' },
    spouse_age_65_or_older: { type: 'boolean', description: 'Joint returns only: will the spouse be 65 or older at the end of the year?' },
    taxpayer_blind: { type: 'boolean', description: 'Is the taxpayer blind for tax purposes?' },
    spouse_blind: { type: 'boolean', description: 'Joint returns only: is the spouse blind for tax purposes?' },
    can_be_claimed_as_dependent: { type: 'boolean', description: 'Can someone else claim the taxpayer (or spouse) as a dependent?' },
    other_situations: {
      type: 'array', minItems: 1, uniqueItems: true,
      items: { type: 'string', enum: Object.keys(OTHER_SITUATIONS) },
      description: `Ask the user which of these apply; ["none"] only if they confirm none do. ${Object.entries(OTHER_SITUATIONS).map(([k, v]) => `${k}: ${v}`).join('; ')}.`,
    },
  },
};

const lines = {
  type: 'object',
  properties: Object.fromEntries(['wages_1a', 'adjusted_gross_income_11a', 'standard_deduction_12e', 'taxable_income_15', 'tax_16', 'child_tax_credit_19', 'total_tax_24', 'federal_withholding_25d', 'additional_child_tax_credit_28', 'total_payments_33'].map((k) => [k, { type: 'integer' }]).concat([['tax_method', { type: 'string', enum: ['tax_table', 'tax_computation_worksheet'] }]])),
  description: 'Amounts in whole dollars, named after the Form 1040 (2025) lines they correspond to.',
};

export const ESTIMATE_OUTPUT = {
  type: 'object',
  required: ['status', 'engine', 'tax_year'],
  properties: {
    status: { type: 'string', enum: ['estimated', 'unsupported_scenario'] },
    engine: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' } } },
    tax_year: { type: 'integer' },
    estimate_id: { type: 'string', description: 'Reference to pass to save_estimate. Valid 24 hours.' },
    expires_at: { type: 'string' },
    parameters_status: { type: 'string', enum: ['final', 'draft'] },
    parameters_note: { type: 'string' },
    filing_status: { type: 'string' },
    outcome: { type: 'string', enum: ['refund', 'amount_owed', 'zero'] },
    amount: { type: 'integer', minimum: 0 },
    lines,
    assumptions: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } } } },
    reasons: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } }, description: 'Why no estimate was given.' },
  },
};

export const SAVE_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['estimate_id'],
  properties: { estimate_id: { type: 'string', minLength: 20, maxLength: 700, description: 'The estimate_id returned by estimate_federal_tax.' } },
};

export const SAVE_OUTPUT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['saved', 'error'] },
    error: { type: 'string', enum: ['estimate_expired', 'estimate_not_found', 'engine_changed', 'estimate_mismatch', 'account_not_found'] },
    message: { type: 'string' },
    record_id: { type: 'string' },
    estimate_id: { type: 'string' },
    saved_at: { type: 'string' },
    already_saved: { type: 'boolean', description: 'True when this estimate was already in this account; the same record is returned.' },
    saved_from: { type: 'string' },
    account: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, email_hint: { type: 'string' } } },
    estimate: { type: 'object', properties: { tax_year: { type: 'integer' }, outcome: { type: 'string' }, amount: { type: 'integer' }, filing_status: { type: 'string' }, lines, parameters_status: { type: 'string' } } },
  },
};

const INSTRUCTIONS = `Federal tax refund estimator (demo, stand-in engine, sample data). Use estimate_federal_tax when someone asks what refund or balance to expect. Ask for every required answer; never assume one (for example, ask before answering "none" for other situations). Wages and withholding are full-year expected amounts. Never ask for a Social Security number. If the result is unsupported_scenario, explain the reasons and do not estimate yourself. When the user wants to keep an estimate, call save_estimate with its estimate_id; it may ask the user to create a demo account first.`;

// Claude's sandbox origin for MCP Apps: first 32 hex chars of SHA-256 of the server URL.
async function claudeUiDomain(serverUrl) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverUrl)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32) + '.claudemcpcontent.com';
}

export function prmUrl(origin, surface) {
  return `${origin}/.well-known/oauth-protected-resource/mcp/${surface}`;
}

export function chatgptAuthMeta(origin, error = 'insufficient_scope', description = 'Create or connect a demo account to save this estimate') {
  return { 'mcp/www_authenticate': [`Bearer resource_metadata="${prmUrl(origin, 'chatgpt')}", error="${error}", error_description="${description}", scope="${SCOPE}"`] };
}

function buildServer({ env, surface, origin, authInfo, uiDomain }) {
  const server = new McpServer(
    { name: 'tax-estimate-demo', title: 'Tax estimate (demo)', version: '0.3.0', websiteUrl: 'https://theaipipe.com/demos/tax-estimate-mcp/' },
    { instructions: INSTRUCTIONS },
  );
  const isChatGPT = surface === 'chatgpt';
  const uiMeta = { ui: { resourceUri: CARD_URI } };

  server.registerTool('estimate_federal_tax', {
    title: 'Estimate federal tax refund',
    description: 'Estimate the federal income tax refund or amount owed for a simple W-2 return (tax year 2026 by default, or 2025), without signing in. Covers single, married filing jointly and head of household, standard deduction, up to two children for the child tax credit. Refuses, with reasons, anything else (Earned Income Credit cases, tips or overtime, self-employment, investments, 65 or older, itemizing and more) instead of guessing. Returns an estimate_id that save_estimate can store.',
    inputSchema: fromJsonSchema(ESTIMATE_INPUT),
    outputSchema: fromJsonSchema(ESTIMATE_OUTPUT),
    annotations: { title: 'Estimate federal tax refund', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ...uiMeta,
      ...(isChatGPT ? {
        securitySchemes: [{ type: 'noauth' }],
        'openai/outputTemplate': CARD_URI,
        'openai/toolInvocation/invoking': 'Estimating your federal tax',
        'openai/toolInvocation/invoked': 'Estimate ready',
      } : {}),
    },
  }, async (args) => {
    const t0 = Date.now();
    const r = await runEstimate(env, args);
    logEvent('tool_estimate', { surface, outcome: r.status === 'estimated' ? 'ok' : 'refused', ms: Date.now() - t0 });
    return { content: [{ type: 'text', text: estimateText(r) }], structuredContent: r };
  });

  server.registerTool('save_estimate', {
    title: 'Save estimate to account',
    description: 'Save an estimate made by estimate_federal_tax into the signed-in demo account. Needs sign-in: if the user has no demo account yet, the host shows a sign-up step and then retries this same call. Saving the same estimate twice returns the same record.',
    inputSchema: fromJsonSchema(SAVE_INPUT),
    outputSchema: fromJsonSchema(SAVE_OUTPUT),
    annotations: { title: 'Save estimate to account', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ...uiMeta,
      ...(isChatGPT ? {
        securitySchemes: [{ type: 'oauth2', scopes: [SCOPE] }],
        'openai/outputTemplate': CARD_URI,
        'openai/toolInvocation/invoking': 'Saving the estimate',
        'openai/toolInvocation/invoked': 'Estimate saved',
      } : {}),
    },
  }, async (args) => {
    const t0 = Date.now();
    const accountId = authInfo?.extra?.accountId;
    if (!accountId || !authInfo.scopes.includes(SCOPE)) {
      // Reached only on the ChatGPT endpoint: Claude's unauthenticated call is answered with HTTP 401
      // before the SDK runs.
      logEvent('auth_challenge', { surface, code: 'tool_error_with_www_authenticate', ms: Date.now() - t0 });
      return {
        isError: true,
        content: [{ type: 'text', text: 'Sign-in required: create or connect a demo account to save this estimate.' }],
        _meta: chatgptAuthMeta(origin),
      };
    }
    const s = await saveEstimate(env, { accountId, estimateId: args.estimate_id, surface });
    logEvent('tool_save', { surface, outcome: s.status === 'saved' ? 'ok' : 'error', code: s.status === 'saved' ? (s.already_saved ? 'already_saved' : 'saved') : s.error, ms: Date.now() - t0 });
    return { content: [{ type: 'text', text: saveText(s) }], structuredContent: s, ...(s.status === 'saved' ? {} : { isError: true }) };
  });

  server.registerResource('estimate-card', CARD_URI, {
    title: 'Federal tax estimate card',
    description: 'Result card with the estimate and a Save button.',
    mimeType: 'text/html;profile=mcp-app',
  }, async () => ({
    contents: [{
      uri: CARD_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: CARD_HTML,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
          ...(uiDomain ? { domain: uiDomain } : {}),
        },
        ...(isChatGPT ? { 'openai/widgetDescription': 'Shows the federal tax estimate, its assumptions and a Save button. The model does not need to repeat the numbers.' } : {}),
      },
    }],
  }));

  return server;
}

export function makeHandlers(origin) {
  const handlers = {};
  for (const surface of ['claude', 'chatgpt']) {
    let uiDomainPromise = surface === 'claude' ? claudeUiDomain(`${origin}/mcp/claude`) : Promise.resolve(null);
    handlers[surface] = (env) => createMcpHandler(async (ctx) => buildServer({ env, surface, origin, authInfo: ctx.authInfo, uiDomain: await uiDomainPromise }), {
      legacy: 'stateless',
      onerror: () => logEvent('error', { surface, code: 'mcp_sdk' }),
    });
  }
  return handlers;
}
