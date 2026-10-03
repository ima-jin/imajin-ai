import { describe, it, expect } from 'vitest';
import { cronMatches, parseCronExpression, previousFire } from '../cron-expression';
import { KERNEL_CRON_MANIFEST, cronJobName } from '../schedule';

const at = (iso: string) => new Date(iso);

describe('parseCronExpression', () => {
  it('parses wildcards, lists, ranges and steps', () => {
    const cron = parseCronExpression('*/15 1-3,22 * 1,6 1-5');
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([1, 2, 3, 22]);
    expect(cron.daysOfMonth.size).toBe(31);
    expect([...cron.months]).toEqual([1, 6]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats `a/n` as a start-to-end stepped range and `a-b/n` as a stepped range', () => {
    expect([...parseCronExpression('5/20 * * * *').minutes]).toEqual([5, 25, 45]);
    expect([...parseCronExpression('0-10/5 * * * *').minutes]).toEqual([0, 5, 10]);
  });

  it('normalises day-of-week 7 to Sunday (0)', () => {
    expect([...parseCronExpression('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it.each([
    ['too few fields', '* * * *'],
    ['too many fields', '* * * * * *'],
    ['minute out of range', '60 * * * *'],
    ['hour out of range', '0 24 * * *'],
    ['day-of-month zero', '0 0 0 * *'],
    ['month 13', '0 0 1 13 *'],
    ['reversed range', '30-10 * * * *'],
    ['zero step', '*/0 * * * *'],
    ['non-numeric', 'abc * * * *'],
    ['empty list member', '1,,2 * * * *'],
    ['negative number', '-5 * * * *'],
  ])('rejects %s', (_label, expr) => {
    expect(() => parseCronExpression(expr)).toThrow(/Invalid cron expression/);
  });
});

describe('cronMatches (UTC)', () => {
  it('matches on the hour for `0 * * * *`', () => {
    const cron = parseCronExpression('0 * * * *');
    expect(cronMatches(cron, at('2026-10-03T14:00:00Z'))).toBe(true);
    expect(cronMatches(cron, at('2026-10-03T14:01:00Z'))).toBe(false);
  });

  it('matches every six hours for `0 */6 * * *`', () => {
    const cron = parseCronExpression('0 */6 * * *');
    const hits = [0, 6, 12, 18].map((h) => cronMatches(cron, at(`2026-10-03T${String(h).padStart(2, '0')}:00:00Z`)));
    expect(hits).toEqual([true, true, true, true]);
    expect(cronMatches(cron, at('2026-10-03T03:00:00Z'))).toBe(false);
  });

  it('uses OR semantics when both day-of-month and day-of-week are restricted', () => {
    const cron = parseCronExpression('0 0 13 * 5'); // the 13th OR any Friday
    expect(cronMatches(cron, at('2026-10-13T00:00:00Z'))).toBe(true); // Tuesday the 13th
    expect(cronMatches(cron, at('2026-10-02T00:00:00Z'))).toBe(true); // Friday the 2nd
    expect(cronMatches(cron, at('2026-10-03T00:00:00Z'))).toBe(false); // Saturday the 3rd
  });

  it('requires the day-of-week alone when day-of-month is a wildcard', () => {
    const cron = parseCronExpression('0 0 * * 1');
    expect(cronMatches(cron, at('2026-10-05T00:00:00Z'))).toBe(true); // Monday
    expect(cronMatches(cron, at('2026-10-06T00:00:00Z'))).toBe(false);
  });
});

describe('previousFire', () => {
  it('returns the current minute when it is itself a fire time', () => {
    const cron = parseCronExpression('*/10 * * * *');
    expect(previousFire(cron, at('2026-10-03T14:20:30Z'))?.toISOString()).toBe('2026-10-03T14:20:00.000Z');
  });

  it('walks back to the previous daily fire', () => {
    const cron = parseCronExpression('0 2 * * *');
    expect(previousFire(cron, at('2026-10-03T01:30:00Z'))?.toISOString()).toBe('2026-10-02T02:00:00.000Z');
  });

  it('returns null when the expression never fires (Feb 31)', () => {
    expect(previousFire(parseCronExpression('0 0 31 2 *'), at('2026-10-03T00:00:00Z'))).toBeNull();
  });
});

describe('kernel manifest', () => {
  it('has only valid schedules, unique job names, and no-overlap on every job', () => {
    const names = KERNEL_CRON_MANIFEST.jobs.map(cronJobName);
    expect(new Set(names).size).toBe(names.length);
    for (const job of KERNEL_CRON_MANIFEST.jobs) {
      expect(() => parseCronExpression(job.schedule), job.path).not.toThrow();
      expect(job.noOverlap, job.path).toBe(true);
    }
  });

  it('preserves the ten schedules that vercel.json used to declare', () => {
    const table = Object.fromEntries(KERNEL_CRON_MANIFEST.jobs.map((j) => [cronJobName(j), j.schedule]));
    expect(table).toEqual({
      'vault-grant-expiry': '0 * * * *',
      'quickbooks-reconcile': '0 */6 * * *',
      'withdrawal-reconcile': '*/15 * * * *',
      'attestation-cleanup': '0 0 * * *',
      'event-subscription-cleanup': '0 1 * * *',
      'claim-stub-expiry': '0 0 * * *',
      'warp-run-watch': '*/10 * * * *',
      'usage-rollup': '0 2 * * *',
      'usage-billed-ingest': '0 2 * * *',
      'google-gmail-watch-renew': '0 3 * * *',
    });
  });

  it('cronJobName falls back to the full path outside /api/cron/', () => {
    expect(cronJobName({ path: '/other/thing' })).toBe('/other/thing');
  });
});
