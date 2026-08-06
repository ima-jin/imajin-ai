/**
 * `warp.run.*` completion events (#1639, Stage 3; #1644).
 *
 * The completion event IS the notification mechanism, so what matters here is
 * that it reaches both the live event stream and the notify reactor by default
 * rather than falling through to an empty chain — a run finishing with nothing
 * configured would otherwise be a silent no-op.
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
    'emits %s to the live stream and notifies by default',
    async (eventType) => {
      const cfg = await getChainConfig(eventType, WARP_SCOPE);

      // Mirrors migration 0084. `notify` is what turns the event into a durable
      // notification row and, through it, a WebSocket push to the dispatching DID
      // (#1644); `emit` keeps the live stream #1639 added.
      expect(cfg.reactors.map((r) => r.type)).toEqual(['emit', 'notify']);
      expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
    },
  );

  it.each([
    ['warp.run.completed', 'Run {{state}}: {{title}}'],
    ['warp.run.timeout', 'Run {{runId}} last seen {{lastKnownState}}'],
  ] as const)('configures the %s notification body from payload fields', async (eventType, body) => {
    const cfg = await getChainConfig(eventType, WARP_SCOPE);
    const notify = cfg.reactors.find((r) => r.type === 'notify');

    expect(notify?.config.body).toBe(body);
    expect(typeof notify?.config.title).toBe('string');
  });
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
