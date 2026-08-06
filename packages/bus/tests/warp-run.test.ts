/**
 * `warp.run.*` completion events (#1639, Stage 3).
 *
 * The completion event IS the notification mechanism, so what matters here is
 * that it reaches the live event stream by default rather than falling through to
 * an empty chain — a run finishing with nothing configured would otherwise be a
 * silent no-op.
 */
import { describe, it, expect, vi } from 'vitest';

// Force chain-config lookups to miss the DB so getChainConfig() falls back to the
// hardcoded DEFAULTS map, the same way supply.test.ts does.
vi.mock('@imajin/db', () => ({
  getClient: () => () => Promise.resolve([]),
}));

import { getChainConfig } from '../src/config';
import type { BusEventMap } from '../src/types';

const WARP_SCOPE = 'warp';

describe('warp.run.* default chains', () => {
  it.each(['warp.run.completed', 'warp.run.timeout'] as const)(
    'emits %s to the live stream by default',
    async (eventType) => {
      const cfg = await getChainConfig(eventType, WARP_SCOPE);

      expect(cfg.reactors.map((r) => r.type)).toEqual(['emit']);
      expect(cfg.reactors[0].enabled).toBe(true);
    },
  );
});

describe('warp.run.completed payload', () => {
  it('type-checks a completed run carrying its PR, cost, and duration', () => {
    const completed = {
      runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
      state: 'SUCCEEDED',
      title: 'Nightly',
      configName: 'veteze-jin',
      runTime: 'PT2M30S',
      statusMessage: null,
      requestUsage: { inferenceCost: 0.42, computeCost: 0.1, platformCost: 0 },
      artifacts: [
        {
          type: 'PULL_REQUEST',
          url: 'https://github.com/ima-jin/imajin-ai/pull/1638',
          branch: 'fix/1630',
        },
      ],
      sessionLink: 'https://app.warp.dev/session/abc',
      principalDid: 'did:imajin:veteze',
      completedAt: '2026-08-06T03:18:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.completed'];

    // The same context_id as warp.agent.dispatched, which is what lets a listener
    // tie a completion back to the dispatch it completes.
    expect(completed.context_id).toBe(completed.runId);
    expect(completed.artifacts[0].url).toContain('/pull/1638');
  });

  it('type-checks a failed run carrying Warp own error code', () => {
    const failed = {
      runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
      state: 'FAILED',
      title: null,
      configName: 'veteze-jin',
      runTime: 'PT4S',
      statusMessage: {
        message: 'Team has no remaining add-on credits',
        errorCode: 'insufficient_credits',
        retryable: false,
      },
      requestUsage: null,
      artifacts: [],
      sessionLink: null,
      principalDid: 'did:imajin:veteze',
      completedAt: '2026-08-06T03:18:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.completed'];

    expect(failed.statusMessage?.errorCode).toBe('insufficient_credits');
  });

  it('type-checks a timeout carrying the last state the watch saw', () => {
    const timedOut = {
      runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
      lastKnownState: 'INPROGRESS',
      principalDid: 'did:imajin:veteze',
      timedOutAt: '2026-08-06T03:48:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.timeout'];

    expect(timedOut.lastKnownState).toBe('INPROGRESS');
  });
});
