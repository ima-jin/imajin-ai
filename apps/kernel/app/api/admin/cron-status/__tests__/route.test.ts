/**
 * GET /api/admin/cron-status (#2550): authed last-run-per-job endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCronSecretAuthContract } from '@/src/lib/kernel/__tests__/cron-route-contract';
import { KERNEL_CRON_MANIFEST } from '@/src/cron/schedule';
import { emptyJobState, writeCronState } from '@/src/cron/state';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from '../route';
import { _setCronSecretForTests } from '@/src/cron/secret';

const AUTH = { authorization: 'Bearer test-secret' };

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/admin/cron-status', { headers });
}

interface StatusBody {
  app: string;
  schedulerSeen: boolean;
  jobs: Array<{
    job: string;
    path: string;
    schedule: string;
    lastStartedAt: string | null;
    lastOutcome: string | null;
    lastHttpStatus: number | null;
    stale: boolean;
  }>;
}

describe('GET /api/admin/cron-status', () => {
  describeCronSecretAuthContract({
    makeRequest,
    callRoute: (request) => GET(request),
  });

  describe('payload', () => {
    const originalStatePath = process.env.CRON_STATE_PATH;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cron-status-route-'));
      _setCronSecretForTests('test-secret');
      process.env.CRON_STATE_PATH = join(dir, 'state.json');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      if (originalStatePath === undefined) delete process.env.CRON_STATE_PATH;
      else process.env.CRON_STATE_PATH = originalStatePath;
    });

    it('lists every manifest job as never-run when the scheduler has not written state', async () => {
      const response = await GET(makeRequest(AUTH));
      const body = (await response.json()) as StatusBody;

      expect(response.status).toBe(200);
      expect(body.app).toBe('kernel');
      expect(body.schedulerSeen).toBe(false);
      expect(body.jobs.map((j) => j.path)).toEqual(KERNEL_CRON_MANIFEST.jobs.map((j) => j.path));
      expect(body.jobs.every((j) => j.lastStartedAt === null && j.lastOutcome === null)).toBe(true);
    });

    it('returns last run time and outcome per job from the scheduler state file', async () => {
      const startedAt = new Date().toISOString();
      writeCronState(process.env.CRON_STATE_PATH!, {
        version: 1,
        app: 'kernel',
        schedulerStartedAt: startedAt,
        jobs: {
          'warp-run-watch': {
            ...emptyJobState(),
            lastStartedAt: startedAt,
            lastOutcome: 'success',
            lastHttpStatus: 200,
            lastDurationMs: 42,
          },
          'usage-rollup': { ...emptyJobState(), lastStartedAt: startedAt, lastOutcome: 'failure', lastHttpStatus: 500 },
        },
      });

      const body = (await (await GET(makeRequest(AUTH))).json()) as StatusBody;
      const byName = Object.fromEntries(body.jobs.map((j) => [j.job, j]));

      expect(body.schedulerSeen).toBe(true);
      expect(byName['warp-run-watch']).toMatchObject({
        schedule: '*/10 * * * *',
        lastStartedAt: startedAt,
        lastOutcome: 'success',
        lastHttpStatus: 200,
      });
      expect(byName['usage-rollup']).toMatchObject({ lastOutcome: 'failure', lastHttpStatus: 500 });
      expect(byName['claim-stub-expiry'].lastOutcome).toBeNull();
    });

    it('does not leak the CRON_SECRET in the payload', async () => {
      const text = await (await GET(makeRequest(AUTH))).text();
      expect(text).not.toContain('test-secret');
    });
  });
});
