import { MANAGER_PAGES, validReportDate } from './manager-pages.mjs';

export function validateReportContext(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report context');
  let timeZone;
  if (value.timeZone !== undefined) {
    if (typeof value.timeZone !== 'string' || value.timeZone.length > 80) throw new Error('Invalid report time zone');
    try { timeZone = new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).resolvedOptions().timeZone; }
    catch { throw new Error('Invalid report time zone'); }
  }
  const page = typeof value.page === 'string' && Object.hasOwn(MANAGER_PAGES, value.page) ? value.page : undefined;
  const range = value.start && value.end && validReportDate(value.start) && validReportDate(value.end) && value.start <= value.end
    && (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000 < 366
    ? { start: value.start, end: value.end } : {};
  return { ...(timeZone ? { timeZone } : {}), ...(page ? { page } : {}), ...range };
}

export function shiftDay(key, days) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function dateClock(timeZone, offset = 'Z') {
  if (!timeZone) {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    const minutes = match ? (match[1] === '-' ? -1 : 1) * (+match[2] * 60 + +match[3]) : 0;
    return {
      label: `Business locale offset ${offset}`,
      key: (timestamp) => new Date(Date.parse(timestamp) + minutes * 60_000).toISOString().slice(0, 10),
      midnight: (key) => new Date(`${key}T00:00:00${offset}`).toISOString(),
    };
  }
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyFor = (timestamp) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  return {
    label: timeZone,
    key: keyFor,
    // Search for the first instant of the local calendar date, including 23/25-hour DST days.
    midnight: (key) => {
      let low = Date.parse(`${key}T00:00:00Z`) - 36 * 3_600_000;
      let high = low + 72 * 3_600_000;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (keyFor(mid) < key) low = mid + 1;
        else high = mid;
      }
      if (keyFor(low) !== key) throw new Error('This calendar date is unavailable in the selected time zone');
      return new Date(low).toISOString();
    },
  };
}
