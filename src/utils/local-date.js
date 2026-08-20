// Timezone-free calendar-date helpers. A NoteForge calendar date is always an
// exact YYYY-MM-DD tuple; only localDateKey() consults the host timezone.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDate(value) {
  const match = DATE_RE.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function formatCalendarDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isCalendarDate(value) {
  return parseCalendarDate(value) !== null;
}

/** Build today's key from local fields. Never use UTC serialization here. */
export function localDateKey(date = new Date()) {
  return formatCalendarDate({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

function ordinal(value) {
  const date = typeof value === 'string' ? parseCalendarDate(value) : value;
  if (!date) return Number.NaN;
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

export function compareCalendarDates(left, right) {
  const a = ordinal(left);
  const b = ordinal(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('Calendar comparison requires valid YYYY-MM-DD dates.');
  return Math.sign(a - b);
}

export function addCalendarDays(value, amount) {
  const date = parseCalendarDate(value);
  if (!date || !Number.isInteger(amount)) throw new TypeError('Calendar-day arithmetic requires a valid date and integer amount.');
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return formatCalendarDate({ year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate() });
}

export function addCalendarMonths(value, amount) {
  const date = parseCalendarDate(value);
  if (!date || !Number.isInteger(amount)) throw new TypeError('Calendar-month arithmetic requires a valid date and integer amount.');
  const monthIndex = date.year * 12 + date.month - 1 + amount;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return formatCalendarDate({ year, month, day: Math.min(date.day, daysInMonth) });
}

export function weekday(value) {
  const date = parseCalendarDate(value);
  if (!date) throw new TypeError('Weekday requires a valid YYYY-MM-DD date.');
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function startOfWeek(value, weekStartsOn = 0) {
  const start = Number.isInteger(weekStartsOn) ? ((weekStartsOn % 7) + 7) % 7 : 0;
  return addCalendarDays(value, -((weekday(value) - start + 7) % 7));
}

export function calendarRange(start, count) {
  if (!isCalendarDate(start) || !Number.isInteger(count) || count < 0) throw new TypeError('Calendar range requires a valid start and non-negative count.');
  return Array.from({ length: count }, (_, index) => addCalendarDays(start, index));
}

export function monthPeriod(value) {
  const date = parseCalendarDate(value);
  if (!date) throw new TypeError('Month period requires a valid YYYY-MM-DD date.');
  const first = formatCalendarDate({ year: date.year, month: date.month, day: 1 });
  const start = startOfWeek(first);
  return { start, days: calendarRange(start, 42), month: date.month, year: date.year };
}

export function weekPeriod(value) {
  const start = startOfWeek(value);
  return { start, days: calendarRange(start, 7) };
}

export function calendarDateLabel(value, options = { year: 'numeric', month: 'long', day: 'numeric' }) {
  const date = parseCalendarDate(value);
  if (!date) return String(value ?? '');
  // Noon local time avoids historical midnight transitions while formatting a
  // tuple for the user's locale; no conversion back to a persisted date occurs.
  return new Date(date.year, date.month - 1, date.day, 12).toLocaleDateString(undefined, options);
}
