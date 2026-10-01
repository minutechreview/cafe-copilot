import { test } from 'vitest';
import assert from 'node:assert/strict';
import { executeManagerTool, managerToolSpecs } from '../manager-tools.mjs';

const businessId = 'shop-a';
const offsetForLocale = () => '+03:00';
const principal = { businessId, actorId: 'owner-a', accessMode: 'owner' };
const config = { business_id: businessId, active_order_types: ['takeaway'], businesses: { name: 'Cafe', currency: 'KWD', locale_default: 'en-KW' } };
const makeOrder = (id, total = 1, extra = {}) => ({ id, business_id: businessId, total, status: 'completed', payment_method: 'cash', order_type: 'takeaway', created_at: '2026-09-01T10:00:00Z', ...extra });

// Only read methods exist. Every awaited page applies tenant, cursor and date filters
// against source rows, including rows added while a report is loading.
function mockClient(tables = {}, { cap = 500, beforeRead = () => {} } = {}) {
  const calls = [];
  const source = { business_config: [config], orders: [], order_adjustments: [], order_items: [], inventory_items: [], ...tables };
  const client = { from(table) {
    const record = { table, filters: [], offset: 0, end: 499, single: false, signal: null }; calls.push(record);
    const query = {
      select(columns) { record.columns = columns; return query; },
      eq(key, value) { record.filters.push(['eq', key, value]); return query; },
      gt(key, value) { record.filters.push(['gt', key, value]); return query; },
      gte(key, value) { record.filters.push(['gte', key, value]); return query; },
      lt(key, value) { record.filters.push(['lt', key, value]); return query; },
      in(key, value) { record.filters.push(['in', key, value]); return query; },
      order(key, options) { record.order = [key, options]; return query; },
      range(start, end) { record.offset = start; record.end = end; return query; },
      maybeSingle() { record.single = true; return query; },
      abortSignal(signal) { record.signal = signal; return query; },
      then(resolve, reject) { return Promise.resolve().then(async () => {
        const override = await beforeRead(record, source, calls);
        if (override) return override;
        const data = source[table].filter((row) => record.filters.every(([kind, key, value]) => kind === 'eq' ? row[key] === value : kind === 'gt' ? row[key] > value : kind === 'gte' ? row[key] >= value : kind === 'lt' ? row[key] < value : value.includes(row[key]))).sort((a, b) => a.id?.localeCompare(b.id || '') || 0);
        return { data: record.single ? data[0] || null : data.slice(record.offset, Math.min(record.end + 1, record.offset + cap)), error: null };
      }).then(resolve, reject); },
    };
    return query;
  } };
  return { client, calls, source };
}
const ctx = (client, extra = {}) => ({ principal, businessId, posClient: client, reportContext: { timeZone: 'Asia/Kuwait' }, ...extra });
const sales = (client, input = {}, extra = {}) => executeManagerTool('get_sales_report', { start_date: '2026-09-01', end_date: '2026-09-01', ...input }, ctx(client, extra), offsetForLocale);

test('sales remain tenant scoped even when tool input tries to override the principal', async () => {
  const { client, calls } = mockClient({ orders: [makeOrder('a', 1.125), makeOrder('b', 500, { business_id: 'shop-b' })] });
  const report = await sales(client, { businessId: 'shop-b', business_id: 'shop-b', actorId: 'someone-else' });
  assert.equal(report.gross, 1.125);
  assert.equal(report.currency, 'KWD');
  assert(calls.every((call) => call.filters.some(([kind, key, value]) => kind === 'eq' && key === 'business_id' && value === businessId)));
});

test('invalid principal or mismatched business fails before querying data', async () => {
  const { client, calls } = mockClient();
  for (const overrides of [{ principal: null }, { principal: { ...principal, actorId: null } }, { businessId: 'shop-b' }, { principal: { ...principal, accessMode: '' } }]) {
    await assert.rejects(() => sales(client, {}, overrides), /Invalid business context/);
  }
  assert.equal(calls.length, 0);
});

test('report needs a caller POS client and never falls back to another database client', async () => {
  await assert.rejects(() => sales(null), /POS client/);
});

test('completed totals, recorded refunds, previous period and item prices keep their correct basis', async () => {
  const { client } = mockClient({
    orders: [makeOrder('a', 7), makeOrder('b', 99, { status: 'cancelled' }), makeOrder('c', 100, { status: 'ready' }), makeOrder('previous', 4, { created_at: '2026-08-31T10:00:00Z' })],
    order_adjustments: [{ id: 'r1', business_id: businessId, type: 'refund', amount: 1.125, created_at: '2026-09-01T12:00:00Z', order_id: 'old-order' }, { id: 'r2', business_id: businessId, type: 'void', amount: 100, created_at: '2026-09-01T12:00:00Z' }],
    order_items: [{ id: 'i1', business_id: businessId, order_id: 'a', menu_item_id: 'coffee', qty: 2, unit_price: 3.5, menu_items: { name: 'Coffee' }, modifiers: [{ price: 1 }] }, { id: 'i2', business_id: businessId, order_id: 'b', qty: 20, unit_price: 10, menu_item_id: 'coffee', menu_items: { name: 'Coffee' } }],
  });
  const report = await sales(client);
  assert.equal(report.gross, 7);
  assert.equal(report.refunds, 1.125);
  assert.equal(report.net, 5.875);
  assert.equal(report.count, 1);
  assert.equal(report.previous.gross, 4);
  assert.deepEqual(report.items, [{ key: 'coffee', name: 'Coffee', quantity: 2, sales: 7 }]);
  assert.match(report.note, /not profit/);
  assert.match(report.note, /older sales/);
});

test('cursor pagination reads all rows when server cap is below the requested 500', async () => {
  const records = Array.from({ length: 251 }, (_, index) => makeOrder(String(index).padStart(4, '0')));
  const { client, calls } = mockClient({ orders: records }, { cap: 100 });
  const report = await sales(client);
  assert.equal(report.count, 251);
  assert.equal(report.gross, 251);
  const pages = calls.filter((call) => call.table === 'orders');
  assert.equal(pages.length, 4);
  assert(pages.every((page) => page.offset === 0 && page.end === 499));
  assert.deepEqual(pages.map((page) => page.filters.find(([kind]) => kind === 'gt')?.[2]), [undefined, '0099', '0199', '0250']);
});

test('new low-ID rows between pages cannot duplicate already fetched sales', async () => {
  let reads = 0;
  const { client } = mockClient({ orders: [makeOrder('b'), makeOrder('c'), makeOrder('d')] }, { cap: 2, beforeRead(record, source) { if (record.table === 'orders' && ++reads === 2) source.orders.push(makeOrder('a', 100)); } });
  const report = await sales(client);
  assert.equal(report.count, 3);
  assert.equal(report.gross, 3);
});

test('a later-page error rejects the report instead of presenting partial totals', async () => {
  let reads = 0;
  const { client } = mockClient({ orders: [makeOrder('a'), makeOrder('b')] }, { cap: 1, beforeRead(record) { if (record.table === 'orders' && ++reads === 2) return { data: null, error: new Error('Database failure') }; } });
  await assert.rejects(() => sales(client), /Report data unavailable/);
});

test('duplicate IDs in a response fail closed before counting a sale twice', async () => {
  const { client } = mockClient({}, { beforeRead(record) { if (record.table === 'orders') return { data: [makeOrder('a'), makeOrder('a')], error: null }; } });
  await assert.rejects(() => sales(client), /rows changed/);
});

test('cancellation propagates to queries and rejects results after a response', async () => {
  const controller = new AbortController();
  const { client, calls } = mockClient({ orders: [makeOrder('a')] }, { beforeRead(record) { if (record.table === 'orders') controller.abort(); } });
  await assert.rejects(() => sales(client, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert(calls.every((call) => call.signal === controller.signal));
  const preAborted = new AbortController(); preAborted.abort();
  const empty = mockClient();
  await assert.rejects(() => sales(empty.client, {}, { signal: preAborted.signal }), { name: 'AbortError' });
  assert.equal(empty.calls.length, 0);
});

test('DST day boundaries follow the requested report time zone and zero-fill the daily trend', async () => {
  const { client, calls } = mockClient({ orders: [
    makeOrder('a', 2, { created_at: '2026-03-08T05:00:00Z' }),
    makeOrder('b', 3, { created_at: '2026-03-09T03:59:59Z' }),
    makeOrder('c', 100, { created_at: '2026-03-09T04:00:00Z' }),
    makeOrder('previous', 7, { created_at: '2026-03-08T04:59:59Z' }),
  ] });
  const report = await sales(client, { start_date: '2026-03-08', end_date: '2026-03-08' }, { reportContext: { timeZone: 'America/New_York' } });
  assert.equal(report.timeZone, 'America/New_York');
  assert.equal(report.gross, 5);
  assert.equal(report.previous.gross, 7);
  assert.deepEqual(report.daily, [{ date: '2026-03-08', sales: 5, orders: 2 }]);
  assert(calls.find((call) => call.table === 'orders').filters.some(([kind, key, value]) => kind === 'lt' && key === 'created_at' && value === '2026-03-09T04:00:00.000Z'));
  const empty = await sales(client, { start_date: '2026-03-10', end_date: '2026-03-11' }, { reportContext: { timeZone: 'America/New_York' } });
  assert.deepEqual(empty.daily, [{ date: '2026-03-10', sales: 0, orders: 0 }, { date: '2026-03-11', sales: 0, orders: 0 }]);
});

test('invalid dates, excessive ranges, invalid time zones and future periods fail closed', async () => {
  const { client } = mockClient();
  for (const input of [{ start_date: '2026-02-30' }, { start_date: '2026-09-02', end_date: '2026-09-01' }, { start_date: '2025-01-01', end_date: '2026-01-02' }, { start_date: '2099-01-01', end_date: '2099-01-01' }]) await assert.rejects(() => sales(client, input));
  await assert.rejects(() => sales(client, {}, { reportContext: { timeZone: 'not-a-time-zone' } }), /Invalid report time zone/);
});

test('exactly 366 inclusive days remain valid and produce a complete zero-filled daily trend', async () => {
  const { client } = mockClient();
  const report = await sales(client, { start_date: '2025-01-01', end_date: '2026-01-01' });
  assert.equal(report.daily.length, 366);
  assert.deepEqual(report.daily[0], { date: '2025-01-01', sales: 0, orders: 0 });
  assert.deepEqual(report.daily.at(-1), { date: '2026-01-01', sales: 0, orders: 0 });
});

test('without a dashboard time zone, calendar boundaries use the configured business locale offset', async () => {
  const { client } = mockClient({ orders: [
    makeOrder('a', 2, { created_at: '2026-08-31T21:00:00Z' }),
    makeOrder('b', 3, { created_at: '2026-09-01T20:59:59Z' }),
    makeOrder('c', 100, { created_at: '2026-09-01T21:00:00Z' }),
    makeOrder('previous', 7, { created_at: '2026-08-31T20:59:59Z' }),
  ] });
  const report = await sales(client, {}, { reportContext: null });
  assert.equal(report.timeZone, 'Business locale offset +03:00');
  assert.equal(report.gross, 5);
  assert.equal(report.previous.gross, 7);
  assert.deepEqual(report.daily, [{ date: '2026-09-01', sales: 5, orders: 2 }]);
});

test('stock reads tenant-scoped low stock and makes truncation explicit without mutations', async () => {
  const { client, calls } = mockClient({ inventory_items: Array.from({ length: 55 }, (_, index) => ({ id: String(index).padStart(4, '0'), business_id: businessId, name: `Milk ${index}`, current_stock: 1, par_min: 2, par_max: 10, unit: 'L', suppliers: { name: 'Local supplier' } })).concat([{ id: 'other', business_id: 'shop-b', current_stock: 0, par_min: 100 }]) });
  const report = await executeManagerTool('get_stock_status', {}, ctx(client), offsetForLocale);
  assert.equal(report.total_items, 55);
  assert.equal(report.low_stock_count, 55);
  assert.equal(report.shown_items.length, 50);
  assert.match(report.note, /up to 50/);
  assert.equal(report.shown_items[0].supplier, 'Local supplier');
  assert(calls.every((call) => call.table === 'inventory_items'));
});

test('manager page tool returns fixed links and never performs the requested operation', async () => {
  const { client, calls } = mockClient();
  const result = await executeManagerTool('get_manager_page', { page: 'close', to: 'https://evil.test', business_id: 'shop-b' }, ctx(client), offsetForLocale);
  assert.equal(result.pageLinks[0].to, '/dashboard/close');
  assert.equal(result.read_only, true);
  assert.match(result.guidance, /approval PIN/);
  assert.equal(calls.length, 0);
  for (const page of ['__proto__', 'https://evil.test', 'drop_table']) await assert.rejects(() => executeManagerTool('get_manager_page', { page }, ctx(client), offsetForLocale));
  await assert.rejects(() => executeManagerTool('delete_orders', {}, ctx(client), offsetForLocale), /Unknown manager tool/);
  assert(managerToolSpecs.every((spec) => spec.toolSpec.inputSchema.json.additionalProperties === false));
});

test('manager page tool rejects nonstring identifiers without coercing them to registry keys', async () => {
  const { client } = mockClient();
  for (const page of [['sales'], { toString: null, valueOf: null }, 1]) await assert.rejects(() => executeManagerTool('get_manager_page', { page }, ctx(client), offsetForLocale), /available manager page/);
});
