/**
 * `warp.run.*` lifecycle events (#1639, Stage 3; #1644; #1682).
 *
 * The event IS the notification mechanism, so what matters here is that it
 * reaches both the live event stream and the notify reactor by default rather
 * than falling through to an empty chain — a run finishing, or moving, with
 * nothing configured would otherwise be a silent no-op.
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
  it.each(['warp.run.completed', 'warp.run.failed', 'warp.run.blocked', 'warp.run.timeout'] as const)(
    'emits %s to the live stream and notifies by default',
    async (eventType) => {
      const cfg = await getChainConfig(eventType, WARP_SCOPE);

      // Mirrors migration 0084 (completed/timeout) and 0109 (failed/blocked,
      // #1838). `notify` is what turns the event into a durable notification
      // row and, through it, a WebSocket push to the dispatching DID (#1644);
      // `emit` keeps the live stream #1639 added.
      expect(cfg.reactors.map((r) => r.type)).toEqual(['emit', 'notify']);
      expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
    },
  );

  // #1805 — reclassified as telemetry-class: mid-run ticks (message-count,
  // cost, status deltas) are operational exhaust, not something a human
  // needs pushed to them. `emit` stays so the signed event stream (and, through
  // it, the #1799 connector telemetry rollup) keeps seeing every tick; `notify`
  // is dropped so a parallel dispatch session no longer floods the inbox.
  it('emits warp.run.progress to the live stream only, with no notify reactor', async () => {
    const cfg = await getChainConfig('warp.run.progress', WARP_SCOPE);

    expect(cfg.reactors.map((r) => r.type)).toEqual(['emit']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it.each([
    ['warp.run.completed', 'Run {{state}}: {{title}}'],
    ['warp.run.failed', 'Run failed: {{title}} — {{summary}}'],
    ['warp.run.blocked', 'Run blocked: {{title}} — {{summary}}'],
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

  it('type-checks a failed run carrying Warp own error code (#1838: its own event type)', () => {
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
      summary: 'insufficient_credits',
      requestUsage: null,
      artifacts: [],
      sessionLink: null,
      principalDid: 'did:imajin:veteze',
      failedAt: '2026-08-06T03:18:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.failed'];

    expect(failed.statusMessage?.errorCode).toBe('insufficient_credits');
    expect(failed.summary).toBe('insufficient_credits');
  });

  it('type-checks a blocked run waiting on a human (#1838)', () => {
    const blocked = {
      runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
      state: 'BLOCKED',
      title: 'Nightly',
      configName: 'veteze-jin',
      statusMessage: { message: 'Waiting on repo access', errorCode: null, retryable: null },
      summary: 'Waiting on repo access',
      artifacts: [],
      sessionLink: null,
      principalDid: 'did:imajin:veteze',
      blockedAt: '2026-08-06T03:18:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.blocked'];

    expect(blocked.summary).toBe('Waiting on repo access');
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

describe('warp.run.progress payload (#1682)', () => {
  it('type-checks a mid-run delta carrying a state change and a new tool call', () => {
    const progress = {
      runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
      principalDid: 'did:imajin:veteze',
      state: 'INPROGRESS',
      previousState: 'QUEUED',
      changed: ['state', 'messages'],
      summary: 'QUEUED → INPROGRESS; 1 new message',
      newMessages: [
        {
          index: 3,
          stepId: 'step-1',
          role: 'tool',
          blockTypes: ['action'],
          actions: ['run_command'],
          text: null,
        },
      ],
      newMessageCount: 1,
      totalMessageCount: 4,
      requestUsage: { inferenceCost: 0.12, computeCost: null, platformCost: null },
      statusMessage: null,
      artifacts: [],
      pollCount: 2,
      observedAt: '2026-08-06T03:18:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.progress'];

    // Same context_id as the dispatch and the eventual completion, so a run's
    // whole life is one thread rather than a scatter of unrelated rows.
    expect(progress.context_id).toBe(progress.runId);
    expect(progress.newMessages[0].actions).toEqual(['run_command']);
  });

  it('type-checks an early error surfaced before any terminal state', () => {
    const progress = {
      runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
      principalDid: 'did:imajin:veteze',
      state: 'INPROGRESS',
      previousState: 'INPROGRESS',
      changed: ['statusMessage'],
      summary: 'sandbox_restart',
      newMessages: [],
      newMessageCount: 0,
      totalMessageCount: 12,
      requestUsage: null,
      statusMessage: { message: 'Sandbox restarted', errorCode: 'sandbox_restart', retryable: true },
      artifacts: [
        {
          type: 'PULL_REQUEST',
          url: 'https://github.com/ima-jin/imajin-ai/pull/1683',
          branch: 'feat/1682',
        },
      ],
      pollCount: 7,
      observedAt: '2026-08-06T03:18:11.000Z',
      context_id: '019f9990-2a46-7552-b177-3a23b17eef2e',
      context_type: 'warp.agent',
    } satisfies BusEventMap['warp.run.progress'];

    expect(progress.statusMessage?.retryable).toBe(true);
    // A PR can land long before the run ends, which is the point of carrying
    // artifacts on a progress event at all.
    expect(progress.artifacts[0].branch).toBe('feat/1682');
  });
});
