import { buildSalesReport } from './sales-metrics.mjs';
import { MANAGER_PAGES, normalisePageLinks, validReportDate } from './manager-pages.mjs';
import { dateClock, shiftDay, validateReportContext } from './report-time.mjs';

const spec = (name, description, properties = {}, required = []) => ({ toolSpec: { name, description, inputSchema: { json: { type: 'object', properties, required, additionalProperties: false } } } });
const rangeProperties = {
  start_date: { type: 'string', description: 'Inclusive YYYY-MM-DD start date, up to 366 days.' },
  end_date: { type: 'string', description: 'Inclusive YYYY-MM-DD end date.' },
};
export const managerToolSpecs = [
  spec('get_sales_report', 'Read the same sales report as the manager dashboard: completed sales, recorded refunds, net after refunds (not profit), orders, average, previous period, daily trend, payment/order-type splits and best selling items. Use for sales over any period, graphs, and comparisons. Dates use the dashboard time zone when provided.', rangeProperties, ['start_date', 'end_date']),
  spec('get_stock_status', 'Read current ingredient stock, low stock, units, reorder levels and supplier names. All returned quantities are recorded values; this does not order or change stock.'),
  spec('get_manager_page', 'Find where to view a report or perform a manager task. Return a safe page link and instructions. Opening a page never closes a register, changes settings, or submits a purchase order.', {
    page: { type: 'string', enum: Object.keys(MANAGER_PAGES) },
    ...rangeProperties,
    date: { type: 'string', description: 'Optional YYYY-MM-DD date for the daily report.' },
  }, ['page']),
];

function checkAbort(signal) {
  if (signal?.aborted) { const error = new Error('Request cancelled'); error.name = 'AbortError'; throw error; }
}
async function rows(makeQuery, signal) {
  const data = [];
  let cursor;
  for (;;) {
    checkAbort(signal);
    let query = makeQuery().order('id', { ascending: true });
    if (cursor) query = query.gt('id', cursor);
    query = query.range(0, 499);
    if (signal) query = query.abortSignal(signal);
    const response = await query;
    checkAbort(signal);
    if (response.error) throw new Error('Report data unavailable');
    if (!Array.isArray(response.data)) throw new Error('Report data unavailable');
    if (!response.data.length) return data;
    for (const row of response.data) {
      if (!row.id || (cursor && row.id <= cursor)) throw new Error('Report rows changed while loading');
      cursor = row.id;
      data.push(row);
    }
    if (data.length > 50_000) throw new Error('Choose a shorter period to read this report in chat');
  }
}
function validatedRange(input) {
  if (!validReportDate(input.start_date) || !validReportDate(input.end_date) || input.start_date > input.end_date) throw new Error('Choose valid report dates');
  const count = (Date.parse(input.end_date) - Date.parse(input.start_date)) / 86_400_000 + 1;
  if (count > 366) throw new Error('Choose a period of up to one year');
  return { start: input.start_date, end: input.end_date, count };
}
function summary(report) {
  return { gross: report.gross, refunds: report.refunds, net: report.net, count: report.count, average: report.average };
}
async function sales(input, ctx, offsetForLocale) {
  const range = validatedRange(input);
  const reportContext = validateReportContext(ctx.reportContext);
  const client = ctx.posClient;
  if (!client) throw new Error('POS client is required');
  let query = client.from('business_config').select('business_id, active_order_types, businesses(name,currency,locale_default)').eq('business_id', ctx.businessId).maybeSingle();
  if (ctx.signal) query = query.abortSignal(ctx.signal);
  const { data: config, error } = await query;
  checkAbort(ctx.signal);
  if (error || !config?.businesses?.currency) throw new Error('Business report settings unavailable');
  const clock = dateClock(reportContext?.timeZone, offsetForLocale(config.businesses.locale_default));
  const generatedAt = new Date().toISOString();
  if (range.end > clock.key(generatedAt)) throw new Error('Choose today or an earlier end date');
  const previousStart = shiftDay(range.start, -range.count);
  const previousEnd = shiftDay(range.start, -1);
  const startIso = clock.midnight(range.start);
  const endIso = clock.midnight(shiftDay(range.end, 1));
  const cutoff = endIso < generatedAt ? endIso : generatedAt;
  const periodQuery = (table, columns) => () => client.from(table).select(columns).eq('business_id', ctx.businessId).gte('created_at', clock.midnight(previousStart)).lt('created_at', cutoff);
  const [orders, adjustments] = await Promise.all([
    rows(periodQuery('orders', 'id,status,total,payment_method,order_type,created_at'), ctx.signal),
    rows(periodQuery('order_adjustments', 'id,type,amount,created_at'), ctx.signal),
  ]);
  const currentOrders = orders.filter(row => Date.parse(row.created_at) >= Date.parse(startIso));
  const currentAdjustments = adjustments.filter(row => Date.parse(row.created_at) >= Date.parse(startIso));
  const ids = currentOrders.filter(row => row.status === 'completed').map(row => row.id);
  const items = [];
  for (let i = 0; i < ids.length; i += 100) {
    items.push(...await rows(() => client.from('order_items').select('id,order_id,menu_item_id,qty,unit_price,menu_items(name)').eq('business_id', ctx.businessId).in('order_id', ids.slice(i, i + 100)), ctx.signal));
  }
  const keys = Array.from({ length: range.count }, (_, i) => shiftDay(range.start, i));
  const current = buildSalesReport(currentOrders, items, currentAdjustments, keys, config.active_order_types, clock.key);
  const previous = buildSalesReport(orders.filter(row => Date.parse(row.created_at) < Date.parse(startIso)), [], adjustments.filter(row => Date.parse(row.created_at) < Date.parse(startIso)), Array.from({ length: range.count }, (_, i) => shiftDay(previousStart, i)), config.active_order_types, clock.key);
  return {
    kind: 'sales_report', start: range.start, end: range.end, currency: config.businesses.currency,
    generatedAt, timeZone: clock.label, ...summary(current), daily: current.daily,
    items: current.items.slice(0, 10), payments: current.payments, types: current.types,
    previous: { start: previousStart, end: previousEnd, ...summary(previous) },
    note: 'Completed sales only. Refunds are counted on the date recorded and may relate to older sales. Net after refunds is not profit. Today is partial. Figures can change after refresh.',
    pageLinks: normalisePageLinks([{ page: 'sales', start_date: range.start, end_date: range.end }]),
  };
}
async function stock(ctx) {
  if (!ctx.posClient) throw new Error('POS client is required');
  const items = await rows(() => ctx.posClient.from('inventory_items').select('id,name,unit,current_stock,par_min,par_max,suppliers(name)').eq('business_id', ctx.businessId), ctx.signal);
  const low = items.filter(row => row.par_min !== null && +row.current_stock < +row.par_min);
  // Bound model context, retaining the full counts and making truncation explicit.
  return { total_items: items.length, low_stock_count: low.length, shown_items: low.slice(0, 50).map(row => ({ name: row.name, unit: row.unit, current_stock: +row.current_stock, minimum: +row.par_min, target: row.par_max === null ? null : +row.par_max, supplier: row.suppliers?.name || null })), note: 'Shows up to 50 items below their configured minimum. Other stock and purchasing details are on the stock page. Recorded quantities only; no stock changes or orders placed.', pageLinks: normalisePageLinks([{ page: 'stock' }]) };
}
export async function executeManagerTool(name, input, ctx, offsetForLocale) {
  const principal = ctx?.principal;
  if (!principal?.businessId || !principal.actorId || !principal.accessMode || ctx.businessId !== principal.businessId) throw new Error('Invalid business context');
  checkAbort(ctx.signal);
  if (name === 'get_sales_report') return sales(input, ctx, offsetForLocale);
  if (name === 'get_stock_status') return stock(ctx);
  if (name === 'get_manager_page') {
    const links = normalisePageLinks([input]);
    if (!links.length) throw new Error('Choose an available manager page and valid dates');
    return { pageLinks: links, guidance: input.page === 'close' ? 'Open Close the day, choose the register on this device, count the cash, then enter an owner or manager approval PIN. Expected cash appears only after approval.' : `Open ${links[0].label} to review the details.`, read_only: true };
  }
  throw new Error('Unknown manager tool');
}
