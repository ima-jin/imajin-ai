/**
 * Minimal 5-field cron expression support for the kernel scheduler (#2550).
 *
 * Supports a wildcard, single values, ranges (`a-b`), steps (wildcard, range
 * or `a` followed by `/n`) and comma lists in each
 * field (minute hour day-of-month month day-of-week). Names (`MON`, `JAN`)
 * and `@hourly`-style macros are deliberately not supported: the manifest only
 * needs the numeric form and a parse error at startup beats a silent
 * misinterpretation. All times are UTC.
 *
 * Day-of-month / day-of-week follow classic cron: when BOTH are restricted a
 * date matches if EITHER does; when only one is restricted that one decides.
 */

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 are both Sunday)
];

export interface ParsedCron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseInteger(text: string, expr: string): number {
  const value = Number(text);
  if (text === '' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid cron expression "${expr}": "${text}" is not a non-negative integer`);
  }
  return value;
}

function parseRange(base: string, spec: FieldSpec, expr: string): [number, number] {
  if (base === '*') return [spec.min, spec.max];
  const dash = base.indexOf('-');
  if (dash === -1) {
    const single = parseInteger(base, expr);
    return [single, single];
  }
  return [parseInteger(base.slice(0, dash), expr), parseInteger(base.slice(dash + 1), expr)];
}

function parsePart(part: string, spec: FieldSpec, expr: string, into: Set<number>): void {
  const slash = part.indexOf('/');
  const base = slash === -1 ? part : part.slice(0, slash);
  const step = slash === -1 ? 1 : parseInteger(part.slice(slash + 1), expr);
  if (step < 1) throw new Error(`Invalid cron expression "${expr}": step must be >= 1`);

  let [from, to] = parseRange(base, spec, expr);
  // `a/n` means "from a to the end of the field, every n".
  if (slash !== -1 && base !== '*' && !base.includes('-')) to = spec.max;
  if (from < spec.min || to > spec.max || from > to) {
    throw new Error(`Invalid cron expression "${expr}": "${part}" is outside ${spec.min}-${spec.max}`);
  }
  for (; from <= to; from += step) into.add(from);
}

function parseField(field: string, spec: FieldSpec, expr: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) parsePart(part, spec, expr, values);
  return values;
}

export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== FIELDS.length) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields, got ${fields.length}`);
  }
  const [minutes, hours, daysOfMonth, months, rawDow] = fields.map((f, i) =>
    parseField(f, FIELDS[i], expr),
  );
  // Normalise Sunday: 7 -> 0.
  const daysOfWeek = new Set([...rawDow].map((d) => d % 7));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  const domOk = cron.daysOfMonth.has(date.getUTCDate());
  const dowOk = cron.daysOfWeek.has(date.getUTCDay());
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** True when `date` (to the minute, UTC) is a fire time for `cron`. */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minutes.has(date.getUTCMinutes()) &&
    cron.hours.has(date.getUTCHours()) &&
    cron.months.has(date.getUTCMonth() + 1) &&
    dayMatches(cron, date)
  );
}

const MINUTE_MS = 60_000;
/** Look-back horizon for `previousFire`: a year of minutes covers any sane expression. */
const MAX_LOOKBACK_MINUTES = 366 * 24 * 60;

/**
 * The most recent fire time at or before `now` (truncated to the minute), or
 * null if the expression never fires within a year (e.g. `0 0 31 2 *`).
 */
export function previousFire(cron: ParsedCron, now: Date): Date | null {
  const start = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let i = 0; i < MAX_LOOKBACK_MINUTES; i += 1) {
    const candidate = new Date(start - i * MINUTE_MS);
    if (cronMatches(cron, candidate)) return candidate;
  }
  return null;
}
