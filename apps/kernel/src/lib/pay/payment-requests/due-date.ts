/**
 * Payment-request due dates are CALENDAR dates, not instants (#2651).
 *
 * `pay.payment_request.due_at` is a `timestamptz`, and a due date has always
 * been stored as UTC midnight of the day the issuer picked (`2026-10-06` →
 * `2026-10-06T00:00:00.000Z`). The calendar date is therefore the UTC date
 * component of the stored instant — and it must be READ back in UTC. Rendering
 * the instant in the viewer's zone (the pre-#2651 `toLocaleDateString()`) shifts
 * it back a day anywhere west of UTC, e.g. America/Toronto showed 10/5/2026 for
 * a due date entered as 10/6.
 *
 * Reading in UTC fixes both new rows and rows already stored as UTC midnight,
 * so no data migration is needed. Every surface that renders a due date must go
 * through {@link formatDueDate}; every writer must go through
 * {@link calendarDateToDueAt}.
 */

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Convert a `YYYY-MM-DD` calendar date (the value of an `<input type="date">`)
 * to the UTC-midnight ISO instant stored in `due_at`. Returns `null` when the
 * string is not a real calendar date (wrong shape, or e.g. `2026-02-31`).
 */
export function calendarDateToDueAt(calendarDate: string): string | null {
  const match = CALENDAR_DATE.exec(calendarDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = new Date(Date.UTC(year, month - 1, day));
  // `Date.UTC` rolls 2026-02-31 over into March; reject anything that doesn't round-trip.
  const roundTrips =
    instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
  return roundTrips ? instant.toISOString() : null;
}

/**
 * Render a stored `due_at` as the calendar date the issuer entered, in the
 * viewer's locale but ALWAYS in UTC (see the module doc). Returns `''` for an
 * unparseable value rather than throwing during render.
 */
export function formatDueDate(dueAt: string, locale?: string): string {
  const instant = new Date(dueAt);
  if (Number.isNaN(instant.getTime())) return '';
  return instant.toLocaleDateString(locale, { timeZone: 'UTC' });
}
