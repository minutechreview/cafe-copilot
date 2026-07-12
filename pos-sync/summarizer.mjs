const money = value => Number(Number(value || 0).toFixed(2));

function dayRange(date, locale) {
  // POS has no timezone column yet. Its configured Sri Lankan locale is the only
  // durable business-local signal available; match the Colombo day used by demo/POS.
  const offset = String(locale || '').toUpperCase().endsWith('-LK') ? '+05:30' : 'Z';
  const start = new Date(`${date}T00:00:00${offset}`);
  if (Number.isNaN(start.valueOf())) throw new Error('date must be YYYY-MM-DD');
  const end = new Date(start.valueOf() + 86_400_000);
  return [start.toISOString(), end.toISOString()];
}

function narrative({ currency, gross, count, variance, refunds }) {
  let unusual = '';
  if (variance <= -1000) unusual = ` A significant cash shortage of ${currency} ${money(Math.abs(variance)).toFixed(2)} needs attention.`;
  else if (variance >= 1000) unusual = ` Cash was over by ${currency} ${money(variance).toFixed(2)}.`;
  else if (refunds.count >= 3) unusual = ` Refund activity was unusually high at ${refunds.count} refunds worth ${currency} ${money(refunds.value).toFixed(2)}.`;
  else if (count <= 5) unusual = ' It was an unusually quiet day.';
  else if (variance) unusual = ` Cash finished ${variance < 0 ? 'short' : 'over'} by ${currency} ${money(Math.abs(variance)).toFixed(2)}.`;
  else unusual = ' Cash reconciled exactly.';
  return `${count} completed orders generated ${currency} ${money(gross).toFixed(2)} in gross sales.${unusual}`;
}

async function rows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

export async function generateDailySummary({ supabase, businessId, date }) {
  if (!supabase || !businessId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('supabase, businessId, and date (YYYY-MM-DD) are required');
  const business = (await rows(supabase.from('businesses').select('id,currency,locale_default').eq('id', businessId).limit(1), 'business'))[0];
  if (!business) throw new Error(`Business not found: ${businessId}`);
  const [start, end] = dayRange(date, business.locale_default);
  const scoped = (table, column, select) => supabase.from(table).select(select).eq('business_id', businessId).gte(column, start).lt(column, end);
  const [orders, sessions, adjustments, events, noSales] = await Promise.all([
    rows(scoped('orders', 'created_at', 'id,status,payment_method,order_type,total,order_items(qty,unit_price,menu_items(name))'), 'orders'),
    rows(scoped('till_sessions', 'closed_at', 'id,opening_float,expected_cash,closing_count,variance,banked_amount'), 'till sessions'),
    rows(scoped('order_adjustments', 'created_at', 'id,type,amount'), 'adjustments'),
    rows(scoped('paid_in_out_events', 'timestamp', 'id,direction,amount,reversed_at'), 'paid in/out'),
    rows(scoped('no_sale_events', 'timestamp', 'id'), 'no sales'),
  ]);
  if (![orders, sessions, adjustments, events, noSales].some(x => x.length)) return null;
  const completed = orders.filter(o => o.status === 'completed');
  const gross = money(completed.reduce((n, o) => n + Number(o.total || 0), 0));
  const sum = (xs, field) => money(xs.reduce((n, x) => n + Number(x[field] || 0), 0));
  const payment = method => sum(completed.filter(o => o.payment_method === method), 'total');
  const type = value => sum(completed.filter(o => o.order_type === value), 'total');
  const byAdjustment = kind => {
    const found = adjustments.filter(a => a.type === kind);
    return { count: found.length, value: sum(found, 'amount') };
  };
  const activeEvents = events.filter(e => !e.reversed_at);
  const byEvent = direction => {
    const found = activeEvents.filter(e => e.direction === direction);
    return { count: found.length, value: sum(found, 'amount') };
  };
  const itemMap = new Map();
  for (const order of completed) for (const item of order.order_items || []) {
    const name = item.menu_items?.name || 'Unknown item';
    const current = itemMap.get(name) || { name, qty: 0, revenue: 0 };
    current.qty += Number(item.qty || 0); current.revenue += Number(item.qty || 0) * Number(item.unit_price || 0);
    itemMap.set(name, current);
  }
  const topItems = [...itemMap.values()].map(x => ({ ...x, qty: money(x.qty), revenue: money(x.revenue) })).sort((a,b) => b.revenue-a.revenue || b.qty-a.qty || a.name.localeCompare(b.name)).slice(0,5);
  const refunds = byAdjustment('refund');
  const variance = sum(sessions, 'variance');
  return {
    schema_version: 1, business_id: businessId, date, currency: business.currency,
    kpis: { gross_sales: gross, order_count: completed.length, avg_transaction_value: completed.length ? money(gross / completed.length) : 0 },
    payment_split: { cash: payment('cash'), card: payment('card') },
    order_type_split: { dine_in: type('dine_in'), takeaway: type('takeaway'), delivery: type('delivery') },
    cash: { sessions_closed: sessions.length, opening_float_total: sum(sessions,'opening_float'), expected_total: sum(sessions,'expected_cash'), counted_total: sum(sessions,'closing_count'), over_short_total: variance, banked_total: sum(sessions,'banked_amount') },
    exceptions: { refunds, voids: byAdjustment('void'), paid_in: byEvent('in'), paid_out: byEvent('out'), no_sale_count: noSales.length },
    top_items: topItems,
    narrative: narrative({ currency: business.currency, gross, count: completed.length, variance, refunds }),
  };
}
