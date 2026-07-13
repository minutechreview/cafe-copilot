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

// Same rounding convention pos-sync/summarizer.mjs uses for money fields, so figures from
// these tools line up with get_day_summary's figures to the cent.
const money = (value) => Number(Number(value || 0).toFixed(2));

// Plain-language reason labels mirroring the POS dashboard's WasteSummaryPage.jsx, so the
// copilot describes waste the same way an owner would see it on that page. Seeded demo data
// currently uses 'damaged'/'quality' (not in this map), which is fine — unmapped codes fall
// back to the raw reason_code, same as the dashboard page does.
const WASTE_REASON_LABELS = {
  spoilage: 'Spoiled / thrown away',
  comp: 'On the house',
  training: 'Training',
  complaint: 'Customer complaint',
  staff_meal: 'Staff meal',
  other: 'Other',
  damaged: 'Damaged',
  quality: 'Quality issue',
};

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
        name: 'get_staff_performance',
        description:
          'Get real per-staff-member performance and cash accountability over a date range: ' +
          'total sales, order count, average transaction value, shifts worked, net cash ' +
          'over/short across their closed shifts, and refunds/voids they APPROVED (not ' +
          'necessarily ones they personally rang up — refunds/voids are attributed to ' +
          'whichever owner or manager approved them). Results are sorted by total sales, ' +
          'highest first. Use this for any question comparing staff members or asking who ' +
          'performed best/worst over a period.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start_date: { type: 'string', description: 'Start of the range, YYYY-MM-DD, inclusive.' },
              end_date: { type: 'string', description: 'End of the range, YYYY-MM-DD, inclusive.' },
            },
            required: ['start_date', 'end_date'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_waste_log',
        description:
          'Get real waste and comp log entries over a date range: which items were wasted or ' +
          'given away, how much, why (reason), and who logged it, plus totals grouped by ' +
          'reason and by item. Use this for any question about wastage, spoilage, comps, or ' +
          '"what are we losing money on".',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start_date: { type: 'string', description: 'Start of the range, YYYY-MM-DD, inclusive.' },
              end_date: { type: 'string', description: 'End of the range, YYYY-MM-DD, inclusive.' },
            },
            required: ['start_date', 'end_date'],
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

function validateDateRange(input) {
  const startDate = input?.start_date;
  const endDate = input?.end_date;
  if (typeof startDate !== 'string' || !DATE_PATTERN.test(startDate)) {
    throw new Error('start_date must be in YYYY-MM-DD format');
  }
  if (typeof endDate !== 'string' || !DATE_PATTERN.test(endDate)) {
    throw new Error('end_date must be in YYYY-MM-DD format');
  }
  if (endDate < startDate) {
    throw new Error('end_date must not be before start_date');
  }
  return { startDate, endDate };
}

/** POS has no timezone column yet — mirrors pos-sync/summarizer.mjs's dayRange offset rule. */
function localeOffset(locale) {
  return String(locale || '').toUpperCase().endsWith('-LK') ? '+05:30' : 'Z';
}

/**
 * Business-local [start, end) ISO bounds spanning startDate through endDate inclusive, using
 * the same fixed-offset day-boundary rule pos-sync/summarizer.mjs's dayRange uses for a
 * single day — extended here to a range so a shift/order/log belongs to the business day its
 * own local calendar date falls on, consistent with get_day_summary.
 */
function businessRangeIso(startDate, endDate, locale) {
  const offset = localeOffset(locale);
  const start = new Date(`${startDate}T00:00:00${offset}`);
  const endDayStart = new Date(`${endDate}T00:00:00${offset}`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(endDayStart.valueOf())) {
    throw new Error('start_date and end_date must be YYYY-MM-DD');
  }
  const end = new Date(endDayStart.valueOf() + 86_400_000);
  return [start.toISOString(), end.toISOString()];
}

/** Shifts a UTC timestamp by the business's fixed offset to read off its local calendar date. */
function toBusinessDateKey(isoTimestamp, offset) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const offsetMinutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const shifted = new Date(new Date(isoTimestamp).valueOf() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

async function fetchBusinessMeta(supabase, businessId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('id,currency,locale_default')
    .eq('id', businessId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`business lookup: ${error.message}`);
  if (!data) throw new Error(`Business not found: ${businessId}`);
  return data;
}

async function fetchRows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

async function runGetStaffPerformance(input, ctx) {
  const { startDate, endDate } = validateDateRange(input);
  const supabase = await getPosClient();
  const business = await fetchBusinessMeta(supabase, ctx.businessId);
  const [start, end] = businessRangeIso(startDate, endDate, business.locale_default);

  // Shifts are attributed to the business day their opened_at falls on, matching the POS
  // dashboard's Staff Reports page (docs/CASH_REPORTING_DESIGN.md design decision 1) — a shift
  // that runs past midnight still counts toward the day it opened.
  const sessions = await fetchRows(
    supabase
      .from('till_sessions')
      .select('id,staff_id,closed_at,variance,staff_profiles!staff_id(name,role)')
      .eq('business_id', ctx.businessId)
      .gte('opened_at', start)
      .lt('opened_at', end),
    'till sessions'
  );

  const sessionIds = sessions.map((session) => session.id);
  const orders = sessionIds.length
    ? await fetchRows(
        supabase
          .from('orders')
          .select('till_session_id,total')
          .eq('business_id', ctx.businessId)
          .eq('status', 'completed')
          .in('till_session_id', sessionIds),
        'orders'
      )
    : [];

  // Refunds/voids are attributed to order_adjustments.approved_by -- the owner/manager who
  // approved the adjustment, not necessarily whoever rang the original sale. Same honesty
  // rule the POS Staff Reports page enforces (see its "Refunds approved" label) — never call
  // this "caused by" or "performed by" the listed staff member.
  const adjustments = await fetchRows(
    supabase
      .from('order_adjustments')
      .select('type,amount,approved_by,staff_profiles(name,role)')
      .eq('business_id', ctx.businessId)
      .gte('created_at', start)
      .lt('created_at', end),
    'order adjustments'
  );

  const staffById = new Map();
  function ensureStaff(staffId, name, role) {
    if (!staffId) return null;
    if (!staffById.has(staffId)) {
      staffById.set(staffId, {
        name: name || 'Unknown staff',
        role: role || null,
        totalSales: 0,
        orderCount: 0,
        shiftsWorked: 0,
        netOverShort: 0,
        refundsCount: 0,
        refundsValue: 0,
        voidsCount: 0,
        voidsValue: 0,
      });
    } else if (name && staffById.get(staffId).name === 'Unknown staff') {
      staffById.get(staffId).name = name;
    }
    return staffById.get(staffId);
  }

  const sessionTotals = new Map();
  orders.forEach((order) => {
    const key = order.till_session_id;
    const totals = sessionTotals.get(key) || { orderCount: 0, revenue: 0 };
    totals.orderCount += 1;
    totals.revenue += Number(order.total || 0);
    sessionTotals.set(key, totals);
  });

  sessions.forEach((session) => {
    const staff = ensureStaff(session.staff_id, session.staff_profiles?.name, session.staff_profiles?.role);
    if (!staff) return;
    const totals = sessionTotals.get(session.id) || { orderCount: 0, revenue: 0 };
    staff.totalSales += totals.revenue;
    staff.orderCount += totals.orderCount;
    staff.shiftsWorked += 1;
    if (session.closed_at && session.variance !== null && session.variance !== undefined) {
      staff.netOverShort += Number(session.variance);
    }
  });

  adjustments.forEach((adjustment) => {
    const staff = ensureStaff(adjustment.approved_by, adjustment.staff_profiles?.name, adjustment.staff_profiles?.role);
    if (!staff) return;
    const amount = Number(adjustment.amount || 0);
    if (adjustment.type === 'refund') {
      staff.refundsCount += 1;
      staff.refundsValue += amount;
    } else if (adjustment.type === 'void') {
      staff.voidsCount += 1;
      staff.voidsValue += amount;
    }
  });

  const staff = [...staffById.values()]
    .map((s) => ({
      name: s.name,
      role: s.role,
      total_sales: money(s.totalSales),
      order_count: s.orderCount,
      average_transaction_value: s.orderCount > 0 ? money(s.totalSales / s.orderCount) : 0,
      shifts_worked: s.shiftsWorked,
      net_over_short: money(s.netOverShort),
      refunds_approved: { count: s.refundsCount, value: money(s.refundsValue) },
      voids_approved: { count: s.voidsCount, value: money(s.voidsValue) },
    }))
    .sort((a, b) => b.total_sales - a.total_sales || a.name.localeCompare(b.name));

  const totals = staff.reduce(
    (acc, s) => ({
      total_sales: money(acc.total_sales + s.total_sales),
      order_count: acc.order_count + s.order_count,
      shifts_worked: acc.shifts_worked + s.shifts_worked,
      net_over_short: money(acc.net_over_short + s.net_over_short),
    }),
    { total_sales: 0, order_count: 0, shifts_worked: 0, net_over_short: 0 }
  );

  return {
    range: { start_date: startDate, end_date: endDate },
    currency: business.currency,
    staff,
    totals,
    ...(staff.length === 0 ? { no_activity: true } : {}),
  };
}

async function runGetWasteLog(input, ctx) {
  const { startDate, endDate } = validateDateRange(input);
  const supabase = await getPosClient();
  const business = await fetchBusinessMeta(supabase, ctx.businessId);
  const [start, end] = businessRangeIso(startDate, endDate, business.locale_default);
  const offset = localeOffset(business.locale_default);

  const logs = await fetchRows(
    supabase
      .from('waste_comp_logs')
      .select('qty,reason_code,logged_by,timestamp,menu_items(name,price)')
      .eq('business_id', ctx.businessId)
      .gte('timestamp', start)
      .lt('timestamp', end)
      .order('timestamp', { ascending: false }),
    'waste logs'
  );

  const entries = logs.map((log) => {
    const price = log.menu_items?.price ? Number(log.menu_items.price) : 0;
    const quantity = Number(log.qty || 0);
    const item = log.menu_items?.name || 'Unknown item';
    return {
      date: toBusinessDateKey(log.timestamp, offset),
      item,
      quantity,
      reason: WASTE_REASON_LABELS[log.reason_code] || log.reason_code,
      reason_code: log.reason_code,
      approx_value: money(quantity * price),
      ...(log.logged_by ? { logged_by: log.logged_by } : {}),
    };
  });

  const byReasonMap = new Map();
  const byItemMap = new Map();
  entries.forEach((entry) => {
    const reasonAgg = byReasonMap.get(entry.reason_code) || {
      reason: entry.reason,
      reason_code: entry.reason_code,
      count: 0,
      quantity: 0,
      approx_value: 0,
    };
    reasonAgg.count += 1;
    reasonAgg.quantity = money(reasonAgg.quantity + entry.quantity);
    reasonAgg.approx_value = money(reasonAgg.approx_value + entry.approx_value);
    byReasonMap.set(entry.reason_code, reasonAgg);

    const itemAgg = byItemMap.get(entry.item) || { item: entry.item, count: 0, quantity: 0, approx_value: 0 };
    itemAgg.count += 1;
    itemAgg.quantity = money(itemAgg.quantity + entry.quantity);
    itemAgg.approx_value = money(itemAgg.approx_value + entry.approx_value);
    byItemMap.set(entry.item, itemAgg);
  });

  const sortByQuantityDesc = (a, b) => b.quantity - a.quantity || b.approx_value - a.approx_value;

  return {
    range: { start_date: startDate, end_date: endDate },
    currency: business.currency,
    entries,
    totals: {
      total_events: entries.length,
      total_quantity: money(entries.reduce((sum, e) => sum + e.quantity, 0)),
      approx_total_value: money(entries.reduce((sum, e) => sum + e.approx_value, 0)),
      // Same caveat WasteSummaryPage.jsx shows the owner: menu prices can change over time,
      // so this is an approximation using current prices, not the price at the time logged.
      approx_value_note: 'Approximate, based on current menu prices which may have changed since these were logged.',
      by_reason: [...byReasonMap.values()].sort(sortByQuantityDesc),
      by_item: [...byItemMap.values()].sort(sortByQuantityDesc),
    },
    ...(entries.length === 0 ? { no_activity: true } : {}),
  };
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
  get_staff_performance: runGetStaffPerformance,
  get_waste_log: runGetWasteLog,
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
