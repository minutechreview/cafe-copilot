// Only page identifiers cross the chat boundary. The model never chooses a URL or query key.
export const MANAGER_PAGES = {
  login: { label: 'Sign in', to: '/login' },
  password: { label: 'Reset password', to: '/reset-password' },
  setup: { label: 'Set up a business', to: '/setup' },
  till: { label: 'Till', to: '/till' },
  orders: { label: 'Order history', to: '/till?orders=1' },
  register_close: { label: 'Close register', to: '/till?close=1' },
  kitchen: { label: 'Kitchen', to: '/kds' },
  catalog: { label: 'Menu preview', to: '/menu' },
  overview: { label: 'Business overview', to: '/dashboard' },
  reports: { label: 'Reports', to: '/dashboard/report-center' },
  products: { label: 'Products & stock', to: '/dashboard/products' },
  sales: { label: 'Sales report', to: '/dashboard/analytics', range: true },
  daily: { label: 'Daily report', to: '/dashboard/endofday', day: true },
  cash: { label: 'Cash history', to: '/dashboard/cash', range: true },
  team: { label: 'Team performance', to: '/dashboard/reports', range: true },
  waste: { label: 'Waste report', to: '/dashboard/waste' },
  stock: { label: 'Stock & suppliers', to: '/dashboard/inventory' },
  menu: { label: 'Menu items', to: '/dashboard/menu' },
  recipes: { label: 'Recipes', to: '/dashboard/recipes' },
  close: { label: 'Close the day', to: '/dashboard/close' },
  staff: { label: 'Staff & PINs', to: '/dashboard/staff' },
  registers: { label: 'Registers & float', to: '/dashboard/tills' },
  settings: { label: 'Team & setup', to: '/dashboard/settings' },
  offline_settings: { label: 'Offline protection', to: '/dashboard/settings#offline-settings' },
  language_settings: { label: 'App language', to: '/dashboard/settings#language-settings' },
};

export function validReportDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function reportRangeFromSearch(search) {
  const params = new URLSearchParams(search);
  const start = params.get('start');
  const end = params.get('end');
  if (!validReportDate(start) || !validReportDate(end) || start > end) return null;
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 >= 366) return null;
  return { start, end };
}

export function normalisePageLinks(value) {
  if (!Array.isArray(value)) return [];
  const links = [];
  for (const entry of value.slice(0, 12)) {
    const page = entry && typeof entry.page === 'string' && Object.hasOwn(MANAGER_PAGES, entry.page) ? MANAGER_PAGES[entry.page] : null;
    if (!page) continue;
    const params = new URLSearchParams();
    const link = { page: entry.page, label: page.label, to: page.to };
    if (page.range && (entry.start_date !== undefined || entry.end_date !== undefined)) {
      if (!validReportDate(entry.start_date) || !validReportDate(entry.end_date) || entry.start_date > entry.end_date) continue;
      if ((Date.parse(entry.end_date) - Date.parse(entry.start_date)) / 86_400_000 >= 366) continue;
      params.set('start', entry.start_date);
      params.set('end', entry.end_date);
      link.start_date = entry.start_date;
      link.end_date = entry.end_date;
      link.period = `${entry.start_date} – ${entry.end_date}`;
    }
    if (page.day && entry.date !== undefined) {
      if (!validReportDate(entry.date)) continue;
      params.set('date', entry.date);
      link.date = entry.date;
      link.period = entry.date;
    }
    if (params.size) link.to += `?${params}`;
    if (!links.some((item) => item.to === link.to)) links.push(link);
    if (links.length === 4) break;
  }
  return links;
}
