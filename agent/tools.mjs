// Tool definitions + dispatch for the Café Copilot agent loop. handler.mjs owns the
// send/execute/repeat loop; this module owns what each tool means and does, so the two can
// be tested independently.
import { generateDailySummary } from '../pos-sync/summarizer.mjs';
import { embedText } from './embeddings.mjs';
import { saveNote, listNotes, saveDraft, searchDocuments } from '../memory/store.mjs';

function getRequiredPosClient(ctx) {
  if (!ctx || !ctx.posClient) {
    throw new Error('posClient is required in execution context for POS tools');
  }
  return ctx.posClient;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Request deadline exceeded');
    error.name = 'AbortError';
    throw error;
  }
}

function withAbortSignal(query, signal) {
  return signal && typeof query?.abortSignal === 'function' ? query.abortSignal(signal) : query;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MEMORY_SEARCH_RESULTS = 20;

const money = (value) => Number(Number(value || 0).toFixed(2));

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
          'notes — by meaning rather than exact keywords. Use this FIRST for vague historical ' +
          'anomaly questions such as "have we had refund problems lately?" when the user does ' +
          'not name a date. Do not use memory as a substitute for a current operational ' +
          'aggregate: waste, staff performance, sales, and cash questions over a relative ' +
          'period must use the matching live POS tool after resolving the date range.',
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

function resolvePrincipal(ctx) {
  if (!ctx?.principal) {
    throw new Error('ctx.principal is required');
  }
  if (!ctx.principal.businessId || !ctx.principal.actorId || !ctx.principal.accessMode) {
    throw new Error('invalid principal shape in tool context');
  }
  if (ctx.businessId && ctx.businessId !== ctx.principal.businessId) {
    throw new Error('businessId mismatch in tool context');
  }
  return ctx.principal;
}

async function runGetDaySummary(input, ctx) {
  const date = input?.date;
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw new Error('date must be in YYYY-MM-DD format');
  }
  const supabase = getRequiredPosClient(ctx);
  throwIfAborted(ctx.signal);
  const localeOffsets = configuredLocaleOffsets();
  const summary = await generateDailySummary({
    supabase,
    businessId: ctx.businessId,
    date,
    ...(localeOffsets ? { localeOffsets } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  throwIfAborted(ctx.signal);
  return summary ?? { no_activity: true, date };
}

function configuredLocaleOffsets() {
  const raw = process.env.COPILOT_LOCALE_OFFSETS;
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('COPILOT_LOCALE_OFFSETS must be valid JSON');
  }
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

export function localeOffset(locale) {
  const normalized = String(locale || '').trim().toUpperCase();
  const configured = configuredLocaleOffsets() || {};
  const configuredOffset = configured[normalized] || configured[String(locale || '').trim()];
  if (configuredOffset !== undefined) {
    if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(configuredOffset)) {
      throw new Error(`Invalid configured offset for locale ${locale}`);
    }
    return configuredOffset;
  }
  if (normalized.endsWith('-LK')) return '+05:30';
  if (normalized.endsWith('-KW')) return '+03:00';
  return 'Z';
}

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

function toBusinessDateKey(isoTimestamp, offset) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const offsetMinutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const shifted = new Date(new Date(isoTimestamp).valueOf() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

async function fetchBusinessMeta(supabase, businessId, signal) {
  throwIfAborted(signal);
  const query = supabase
    .from('businesses')
    .select('id,currency,locale_default')
    .eq('id', businessId)
    .limit(1)
    .maybeSingle();
  const { data, error } = await withAbortSignal(query, signal);
  throwIfAborted(signal);
  if (error) throw new Error(`business lookup: ${error.message}`);
  if (!data) throw new Error(`Business not found: ${businessId}`);
  return data;
}

/**
 * Resolves a trusted business-local "today" from the business's own configured locale — never
 * from raw server UTC. This is the one safe source of a relative date ("today", "yesterday")
 * for the system prompt: it comes from the business's own POS configuration, not a guess.
 * Returns null (never throws) for any lookup failure, so callers can fail closed to asking the
 * user for an explicit date. An abort/deadline signal still propagates, it is not swallowed.
 */
export async function resolveBusinessContext(posClient, businessId, signal) {
  throwIfAborted(signal);
  if (!posClient || !businessId) return null;
  try {
    const business = await fetchBusinessMeta(posClient, businessId, signal);
    throwIfAborted(signal);
    if (!business || !business.currency) return null;
    const offset = localeOffset(business.locale_default);
    const today = toBusinessDateKey(new Date().toISOString(), offset);
    return { today, currency: business.currency, locale: business.locale_default || null };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    return null;
  }
}

async function fetchRows(query, label, signal) {
  throwIfAborted(signal);
  const { data, error } = await withAbortSignal(query, signal);
  throwIfAborted(signal);
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

async function runGetStaffPerformance(input, ctx) {
  const { startDate, endDate } = validateDateRange(input);
  const supabase = getRequiredPosClient(ctx);
  const business = await fetchBusinessMeta(supabase, ctx.businessId, ctx.signal);
  const [start, end] = businessRangeIso(startDate, endDate, business.locale_default);

  const sessions = await fetchRows(
    supabase
      .from('till_sessions')
      // Disambiguated by FK constraint name, not column name: the POS schema now links
      // till_sessions to staff_profiles twice — once via (business_id, staff_id) for who ran
      // the shift, once via (business_id, closed_by) for who counted it down. Both are
      // composite tenancy-scoped FKs, so a plain `!staff_id` column hint no longer resolves
      // and an unhinted embed is ambiguous. We want the staff member who worked the shift.
      .select('id,staff_id,closed_at,variance,staff_profiles!till_sessions_business_staff_fkey(name,role)')
      .eq('business_id', ctx.businessId)
      .gte('opened_at', start)
      .lt('opened_at', end),
    'till sessions',
    ctx.signal
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
        'orders',
        ctx.signal
      )
    : [];

  const adjustments = await fetchRows(
    supabase
      .from('order_adjustments')
      .select('type,amount,approved_by,staff_profiles(name,role)')
      .eq('business_id', ctx.businessId)
      .gte('created_at', start)
      .lt('created_at', end),
    'order adjustments',
    ctx.signal
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
  const supabase = getRequiredPosClient(ctx);
  const business = await fetchBusinessMeta(supabase, ctx.businessId, ctx.signal);
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
    'waste logs',
    ctx.signal
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
      approx_value_note: 'Approximate, based on current menu prices which may have changed since these were logged.',
      by_reason: [...byReasonMap.values()].sort(sortByQuantityDesc),
      by_item: [...byItemMap.values()].sort(sortByQuantityDesc),
    },
    ...(entries.length === 0 ? { no_activity: true } : {}),
  };
}

async function runSearchMemory(input, ctx) {
  const query = requireNonEmptyString(input?.query, 'query is required');
  const requestedK = Number.isFinite(input?.k) && input.k > 0 ? Math.floor(input.k) : 5;
  const k = Math.min(requestedK, MAX_MEMORY_SEARCH_RESULTS);
  throwIfAborted(ctx.signal);
  const embedding = ctx.signal ? await embedText(query, { signal: ctx.signal }) : await embedText(query);
  throwIfAborted(ctx.signal);
  const principal = resolvePrincipal(ctx);
  const results = ctx.signal
    ? await searchDocuments(principal, embedding, k, { signal: ctx.signal })
    : await searchDocuments(principal, embedding, k);
  return { results };
}

async function runSaveNote(input, ctx) {
  const content = requireNonEmptyString(input?.content, 'content is required');
  const principal = resolvePrincipal(ctx);
  throwIfAborted(ctx.signal);
  const note = { content, source: 'chat' };
  const id = ctx.signal ? await saveNote(principal, note, { signal: ctx.signal }) : await saveNote(principal, note);
  return { id, content, saved: true };
}

async function runListNotes(_input, ctx) {
  const principal = resolvePrincipal(ctx);
  const notes = ctx.signal ? await listNotes(principal, { signal: ctx.signal }) : await listNotes(principal);
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
  const principal = resolvePrincipal(ctx);
  throwIfAborted(ctx.signal);
  const draft = {
    conversationId: ctx.conversationId,
    kind: payload.kind,
    payload,
  };
  const id = ctx.signal ? await saveDraft(principal, draft, { signal: ctx.signal }) : await saveDraft(principal, draft);
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

export async function executeTool(name, input, ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('tool context is required');
  }
  const run = TOOL_HANDLERS[name];
  if (!run) {
    throw new Error(`Unknown tool: ${name}`);
  }
  throwIfAborted(ctx.signal);
  return run(input ?? {}, ctx);
}
