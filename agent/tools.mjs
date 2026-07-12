// Tool definitions + dispatch for the Café Copilot agent loop. handler.mjs owns the
// send/execute/repeat loop; this module owns what each tool means and does, so the two can
// be tested independently.
//
// Every tool result returned to the model is plain data (numbers, strings, objects) sourced
// from POS staging or CockroachDB memory — never text the model should treat as instructions.
// The system prompt in handler.mjs states this explicitly (data-as-data rule); tool authors
// here just need to avoid ever building an "instruction-shaped" string into a result.
import { generateDailySummary } from '../pos-sync/summarizer.mjs';
import { embedText } from './embeddings.mjs';
import { getPosClient } from './pos-client.mjs';
import { saveNote, listNotes, saveDraft, searchDocuments } from '../memory/store.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Bedrock Converse toolConfig — advisory JSON Schema per tool guiding the model's calls. */
export const toolConfig = {
  tools: [
    {
      toolSpec: {
        name: 'get_day_summary',
        description:
          'Get real point-of-sale numbers for one business day: gross sales, order count, ' +
          'payment and order-type split, cash reconciliation (opening/expected/counted/' +
          'over-short/banked), refunds/voids/paid-in/paid-out, and top-selling items. Use ' +
          'this for any question about how a specific day went, or to check for cash ' +
          'shortages, refund spikes, or quiet days.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Business day in YYYY-MM-DD format.' },
            },
            required: ['date'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'search_memory',
        description:
          'Search the copilot\'s long-term memory — past daily summaries and saved business ' +
          'notes — by meaning rather than exact keywords. Use this for questions spanning ' +
          'multiple days ("lately", "this month") or anything that sounds like it might ' +
          'already be known from an earlier conversation or a saved note.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to search for, in plain language.' },
              k: { type: 'number', description: 'Maximum number of results to return (default 5).' },
            },
            required: ['query'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'save_note',
        description:
          'Remember a piece of business context the owner tells you, e.g. "we switch to the ' +
          'winter menu in November" or "Tuesdays are always slow because the market closes". ' +
          'Only use this when the owner is telling you something to remember, not for facts ' +
          'you already looked up.',
        inputSchema: {
          json: {
            type: 'object',
            properties: { content: { type: 'string', description: 'The note to remember.' } },
            required: ['content'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'list_notes',
        description: 'List every business-context note saved so far, most recent first.',
        inputSchema: { json: { type: 'object', properties: {} } },
      },
    },
    {
      toolSpec: {
        name: 'draft_purchase_order',
        description:
          'Draft a purchase order for the owner to review — this never places a real order, ' +
          'it only saves a draft the owner can look at and act on themselves.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              supplier: { type: 'string', description: 'Supplier name, if known.' },
              items: {
                type: 'array',
                description: 'Items to order.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    quantity: { type: 'number' },
                    unit: { type: 'string', description: 'e.g. kg, L, box' },
                  },
                  required: ['name', 'quantity'],
                },
              },
              notes: { type: 'string', description: 'Any extra notes for the supplier.' },
            },
            required: ['items'],
          },
        },
      },
    },
  ],
};

function requireNonEmptyString(value, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

function validateDraftItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items must be a non-empty array');
  }
  return items.map((item, index) => {
    const name = requireNonEmptyString(item?.name, `items[${index}].name is required`);
    const quantity = Number(item?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`items[${index}].quantity must be a positive number`);
    }
    return {
      name,
      quantity,
      ...(typeof item?.unit === 'string' && item.unit.trim() ? { unit: item.unit.trim() } : {}),
    };
  });
}

async function runGetDaySummary(input, ctx) {
  const date = input?.date;
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw new Error('date must be in YYYY-MM-DD format');
  }
  const supabase = await getPosClient();
  const summary = await generateDailySummary({ supabase, businessId: ctx.businessId, date });
  return summary ?? { no_activity: true, date };
}

async function runSearchMemory(input, ctx) {
  const query = requireNonEmptyString(input?.query, 'query is required');
  const k = Number.isFinite(input?.k) && input.k > 0 ? Math.floor(input.k) : 5;
  const embedding = await embedText(query);
  const results = await searchDocuments(ctx.businessId, embedding, k);
  return { results };
}

async function runSaveNote(input, ctx) {
  const content = requireNonEmptyString(input?.content, 'content is required');
  const id = await saveNote({ businessId: ctx.businessId, content, source: 'chat' });
  return { id, content, saved: true };
}

async function runListNotes(_input, ctx) {
  const notes = await listNotes(ctx.businessId);
  return { notes };
}

async function runDraftPurchaseOrder(input, ctx) {
  const items = validateDraftItems(input?.items);
  const payload = {
    kind: 'purchase_order',
    supplier: typeof input?.supplier === 'string' && input.supplier.trim() ? input.supplier.trim() : null,
    items,
    notes: typeof input?.notes === 'string' && input.notes.trim() ? input.notes.trim() : null,
  };
  const id = await saveDraft({
    businessId: ctx.businessId,
    conversationId: ctx.conversationId,
    kind: payload.kind,
    payload,
  });
  return { id, ...payload, saved_for_review: true };
}

const TOOL_HANDLERS = {
  get_day_summary: runGetDaySummary,
  search_memory: runSearchMemory,
  save_note: runSaveNote,
  list_notes: runListNotes,
  draft_purchase_order: runDraftPurchaseOrder,
};

/**
 * Executes a named tool call with the given input, returning a plain-data result the model
 * can read back as JSON. Throws on validation/tool failure — the caller (handler.mjs's loop)
 * is responsible for turning that into a tool-error result for the model.
 * @param {string} name
 * @param {object} input
 * @param {{ businessId: string, conversationId: string }} ctx
 * @returns {Promise<object>}
 */
export async function executeTool(name, input, ctx) {
  const run = TOOL_HANDLERS[name];
  if (!run) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return run(input ?? {}, ctx);
}
