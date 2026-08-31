/**
 * `consent.requested` / `approval.decision` → default reactor chains (#1817).
 *
 * `consent.requested` must reach both `emit` (the signed event stream) and
 * `notify` (the #1644/#1645 WebSocket push that surfaces the /jin confirm
 * card to the approver — `event.subject`). `approval.decision` is emitted
 * back for the requesting system to consume off the signed event stream only
 * — no human-facing notification is implied by the primitive itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockNotify } = vi.hoisted(() => ({
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Force getChainConfig() to use the fallback DEFAULTS map, which mirrors
// migration 0109 for consent.requested / approval.decision.
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

const REQUESTER = 'did:imajin:openclaw-plugin';
const APPROVER = 'did:imajin:human';
const REQUEST_ID = 'creq_test123';

const REQUESTED_PAYLOAD: BusEventMap['consent.requested'] = {
  requestId: REQUEST_ID,
  requesterDid: REQUESTER,
  approverDid: APPROVER,
  kind: 'openclaw.exec_command',
  summary: 'Run `rm -rf /tmp/build` on the build host',
  detail: { command: 'rm -rf /tmp/build' },
  expiresAt: '2026-08-06T03:33:11.000Z',
  context_id: REQUEST_ID,
  context_type: 'consent_request',
};

const DECISION_PAYLOAD: BusEventMap['approval.decision'] = {
  requestId: REQUEST_ID,
  requesterDid: REQUESTER,
  approverDid: APPROVER,
  kind: 'openclaw.exec_command',
  decision: 'approve',
  attestationId: 'cdec_1',
  decidedAt: '2026-08-06T03:34:11.000Z',
  context_id: REQUEST_ID,
  context_type: 'consent_request',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);
});

describe('publishing consent.requested', () => {
  it('fires both emit and notify, addressed to the approver', async () => {
    await publish('consent.requested', {
      issuer: REQUESTER,
      subject: APPROVER,
      scope: 'consent',
      payload: REQUESTED_PAYLOAD,
    });

    // `emit` and `notify` are fire-and-forget, so wait for the .catch() job
    // chained inside publish() to be scheduled before asserting.
    await Promise.resolve();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);

    const [event, config] = mockNotify.mock.calls[0];
    expect(event).toMatchObject({
      type: 'consent.requested',
      issuer: REQUESTER,
      subject: APPROVER,
      scope: 'consent',
      payload: REQUESTED_PAYLOAD,
    });
    expect(config).toMatchObject({
      title: 'Consent requested: {{kind}}',
      body: '{{summary}}',
    });
  });
});

describe('publishing approval.decision', () => {
  it('emits to the live stream but never notifies', async () => {
    await publish('approval.decision', {
      issuer: APPROVER,
      subject: REQUESTER,
      scope: 'consent',
      payload: DECISION_PAYLOAD,
    });
    await Promise.resolve();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [event] = mockEmit.mock.calls[0];
    expect(event).toMatchObject({
      type: 'approval.decision',
      issuer: APPROVER,
      subject: REQUESTER,
      payload: DECISION_PAYLOAD,
    });

    expect(mockNotify).not.toHaveBeenCalled();
  });
});
