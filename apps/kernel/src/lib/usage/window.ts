/**
 * `?window=` parsing for the usage read API (#2030).
 *
 * Accepts either a calendar month (`YYYY-MM`) or an explicit inclusive date
 * range (`YYYY-MM-DD..YYYY-MM-DD`), both UTC. Returns a half-open
 * `[from, to)` interval so callers can use it directly with `gte`/`lt`
 * conditions the same way `lib/usage/rollup.ts`'s `previousUtcDayWindow`
 * does. `label` echoes back exactly what the caller asked for (or the
 * resolved default), so the response is honest about which window it
 * answered.
 */

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

export interface UsageWindow {
  from: Date;
  to: Date;
  label: string;
}

/** `YYYY-MM` for the current UTC month — the default window when none is given. */
export function currentMonthLabel(now: Date = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

function monthWindow(year: number, month: number): { from: Date; to: Date } {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return { from, to };
}

/**
 * Parse a `window` query param into a `[from, to)` interval.
 *
 * Returns `null` for a malformed value (caller should respond 400) —
 * never throws. `raw` may be `null` (absent query param, e.g.
 * `URLSearchParams.get`'s return type), in which case the current UTC
 * month is returned.
 */
export function parseUsageWindow(raw: string | null, now: Date = new Date()): UsageWindow | null {
  const label = raw ?? currentMonthLabel(now);

  const monthMatch = MONTH_RE.exec(label);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return null;
    return { ...monthWindow(year, month), label };
  }

  const rangeMatch = RANGE_RE.exec(label);
  if (rangeMatch) {
    const from = new Date(`${rangeMatch[1]}T00:00:00.000Z`);
    // Inclusive end date → exclusive upper bound is the day after.
    const toStart = new Date(`${rangeMatch[2]}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(toStart.getTime())) return null;
    const to = new Date(toStart.getTime() + 24 * 60 * 60 * 1000);
    if (to <= from) return null;
    return { from, to, label };
  }

  return null;
}
