function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const amount = (value) => Number(value || 0);
const rounded = (value) => Math.round((value + Number.EPSILON) * 1000) / 1000;

export function buildSalesReport(
  orders,
  items,
  adjustments,
  keys,
  configuredTypes = [],
  keyForTimestamp = (timestamp) => dateKey(new Date(timestamp))
) {
  const completed = orders.filter((order) => order.status === 'completed');
  const completedIds = new Set(completed.map((order) => order.id));
  const gross = rounded(
    completed.reduce((sum, order) => sum + amount(order.total), 0)
  );
  const refunds = rounded(
    adjustments
      .filter((row) => row.type === 'refund')
      .reduce((sum, row) => sum + amount(row.amount), 0)
  );
  const dailyMap = new Map(
    keys.map((key) => [key, { date: key, sales: 0, orders: 0 }])
  );
  const types = new Map();
  const payments = new Map();
  for (const order of completed) {
    const bucket = dailyMap.get(keyForTimestamp(order.created_at));
    if (bucket) {
      bucket.sales += amount(order.total);
      bucket.orders += 1;
    }
    for (const [map, key] of [
      [types, order.order_type],
      [payments, order.payment_method],
    ]) {
      const row = map.get(key) || { key, sales: 0, orders: 0 };
      row.sales += amount(order.total);
      row.orders += 1;
      map.set(key, row);
    }
  }
  const itemMap = new Map();
  for (const item of items) {
    if (!completedIds.has(item.order_id)) continue;
    const key = item.menu_item_id || item.menu_items?.name || 'unavailable';
    const row = itemMap.get(key) || {
      key,
      name: item.menu_items?.name || 'Item no longer available',
      quantity: 0,
      sales: 0,
    };
    row.quantity += amount(item.qty);
    // TillPage persists unit_price INCLUDING the chosen extras; adding modifiers again overstates sales.
    row.sales += amount(item.unit_price) * amount(item.qty);
    itemMap.set(key, row);
  }
  const typeKeys = [...new Set([...(configuredTypes || []), ...types.keys()])];
  return {
    gross,
    refunds,
    net: rounded(gross - refunds),
    count: completed.length,
    average: completed.length ? gross / completed.length : 0,
    daily: [...dailyMap.values()].map((row) => ({
      ...row,
      sales: rounded(row.sales),
    })),
    types: typeKeys
      .filter((key) => types.has(key))
      .map((key) => types.get(key)),
    payments: [...payments.values()],
    items: [...itemMap.values()]
      .map((row) => ({
        ...row,
        quantity: rounded(row.quantity),
        sales: rounded(row.sales),
      }))
      .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name)),
    orders: [...orders].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)
    ),
  };
}

