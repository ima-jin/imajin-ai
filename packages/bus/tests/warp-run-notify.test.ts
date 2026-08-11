/**
 * `warp.run.*` → notify reactor (#1644; #1682; #1805).
 *
 * This is the bus-chain test the issue asks for: publishing a Warp run
 * *terminal* event must invoke the notify reactor for the event subject. The
 * notify route then writes the DB row and pushes the WebSocket frame; that
 * lower layer is covered in the kernel tests.
 *
 * `warp.run.progress` is the opposite assertion (#1805): it is telemetry-class,
 * so publishing it must reach `emit` (the signed event stream, which is what
 * the #1799 connector telemetry rollup queries) but must NEVER invoke `notify`
 * — that is exactly the mid-run notification flood the issue removes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockNotify } = vi.hoisted(() => ({
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// Force getChainConfig() to use the fallback DEFAULTS map, which now mirrors
// migration 0084 for warp.run.*.
vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve([]) }));

vi.mock('../src/registry', () => ({
  getReactor: (type: string) => {
    if (type === 'emit') return mockEmit;
    if (type === 'notify') return mockNotify;
    return undefined;
  },
}));

import { publish } from '../src/publish';
import type { BusEventMap } from '../src/types';

const PRINCIPAL = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

const COMPLETED_PAYLOAD: BusEventMap['warp.run.completed'] = {
  runId: RUN_ID,
  state: 'SUCCEEDED',
  title: 'Nightly',
  configName: 'veteze-jin',
  runTime: 'PT2M30S',
  statusMessage: null,
  requestUsage: { inferenceCost: 0.42, computeCost: 0.1, platformCost: 0 },
  artifacts: [],
  sessionLink: 'https://app.warp.dev/session/abc',
  principalDid: PRINCIPAL,
  completedAt: '2026-08-06T03:18:11.000Z',
  context_id: RUN_ID,
  context_type: 'warp.agent',
};

const PROGRESS_PAYLOAD: BusEventMap['warp.run.progress'] = {
  runId: RUN_ID,
  principalDid: PRINCIPAL,
  state: 'INPROGRESS',
  previousState: 'QUEUED',
  changed: ['state', 'messages'],
  summary: 'QUEUED → INPROGRESS; 1 new message',
  newMessages: [
    {
      index: 0,
      stepId: 'step-1',
      role: 'assistant',
      blockTypes: ['text'],
      actions: [],
      text: 'working',
    },
  ],
  newMessageCount: 1,
  totalMessageCount: 1,
  requestUsage: { inferenceCost: 0.12, computeCost: null, platformCost: null },
  statusMessage: null,
  artifacts: [],
  pollCount: 2,
  observedAt: '2026-08-06T03:18:11.000Z',
  context_id: RUN_ID,
  context_type: 'warp.agent',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);
});

describe('publishing warp.run.completed', () => {
  it('fires the notify reactor for the dispatching agent DID', async () => {
    await publish('warp.run.completed', {
      issuer: PRINCIPAL,
      subject: PRINCIPAL,
      scope: 'warp',
      payload: COMPLETED_PAYLOAD,
    });

    // `emit` and `notify` are both fire-and-forget, so wait for the .catch() job
    // chained inside publish() to be scheduled before asserting.
    await Promise.resolve();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);

    const [event, config] = mockNotify.mock.calls[0];
    expect(event).toMatchObject({
      type: 'warp.run.completed',
      issuer: PRINCIPAL,
      subject: PRINCIPAL,
      scope: 'warp',
      payload: COMPLETED_PAYLOAD,
    });
    expect(config).toMatchObject({
      title: 'Warp run completed',
      body: 'Run {{state}}: {{title}}',
    });
  });

  it('also notifies on a timeout event', async () => {
    await publish('warp.run.timeout', {
      issuer: PRINCIPAL,
      subject: PRINCIPAL,
      scope: 'warp',
      payload: {
        runId: RUN_ID,
        lastKnownState: 'INPROGRESS',
        principalDid: PRINCIPAL,
        timedOutAt: '2026-08-06T03:48:11.000Z',
        context_id: RUN_ID,
        context_type: 'warp.agent',
      },
    });
    await Promise.resolve();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({
      title: 'Warp run timed out',
      body: 'Run {{runId}} last seen {{lastKnownState}}',
    });
  });
});

describe('publishing warp.run.progress (#1682; telemetry-class per #1805)', () => {
  it('emits to the live stream but never notifies, even across repeated ticks', async () => {
    await publish('warp.run.progress', {
      issuer: PRINCIPAL,
      subject: PRINCIPAL,
      scope: 'warp',
      payload: PROGRESS_PAYLOAD,
    });
    await publish('warp.run.progress', {
      issuer: PRINCIPAL,
      subject: PRINCIPAL,
      scope: 'warp',
      payload: { ...PROGRESS_PAYLOAD, summary: '2 new messages', pollCount: 3 },
    });
    await Promise.resolve();

    // `emit` fires once per tick — the signed event stream (registry.system_events,
    // queryable per-DID) is unaffected by the reclassification.
    expect(mockEmit).toHaveBeenCalledTimes(2);
    const [event] = mockEmit.mock.calls[0];
    expect(event).toMatchObject({
      type: 'warp.run.progress',
      subject: PRINCIPAL,
      payload: PROGRESS_PAYLOAD,
    });

    // The notification flood this issue fixes: notify must never fire for a
    // progress tick, no matter how many ticks a run produces.
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
