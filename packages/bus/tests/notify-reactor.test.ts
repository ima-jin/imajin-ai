/**
 * The `notify` reactor (#1644).
 *
 * Two things matter here. First, the reactor sends to `event.subject` unless the
 * chain config names someone else — that is what makes a `warp.run.completed`
 * notification land on the DID that dispatched the run rather than nowhere.
 * Second, a configured title/body may carry `{{field}}` placeholders, because a
 * chain config row is static and the interesting part of a run outcome (its
 * state) is not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockInterest } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
  mockInterest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/notify', () => ({ send: mockSend, interest: mockInterest }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { notifyReactor } from '../src/reactors/notify';
import type { BusEvent } from '../src/types';

const PRINCIPAL = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

/** The chain config migration 0084 seeds for `warp.run.completed`. */
const COMPLETED_CONFIG = {
  title: 'Warp run completed',
  body: 'Run {{state}}: {{title}}',
};

function completedEvent(payload: Record<string, unknown> = {}): BusEvent {
  return {
    type: 'warp.run.completed',
    issuer: PRINCIPAL,
    subject: PRINCIPAL,
    scope: 'warp',
    payload: {
      runId: RUN_ID,
      state: 'SUCCEEDED',
      title: 'Nightly',
      principalDid: PRINCIPAL,
      ...payload,
    },
  };
}

/** The arguments the notify service was called with. */
function sent(): Record<string, unknown> {
  return mockSend.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  mockInterest.mockResolvedValue(undefined);
});

// ─── Recipient ───────────────────────────────────────────────────────────────

describe('recipient resolution', () => {
  it('sends to the event subject — the DID that dispatched the run', async () => {
    await notifyReactor(completedEvent(), COMPLETED_CONFIG);

    expect(sent().to).toBe(PRINCIPAL);
  });

  it('honours an explicit config.to override', async () => {
    await notifyReactor(completedEvent(), { ...COMPLETED_CONFIG, to: 'did:imajin:ops' });

    expect(sent().to).toBe('did:imajin:ops');
  });

  it('sends nothing when the event has no subject and no override', async () => {
    await notifyReactor({ ...completedEvent(), subject: '' }, COMPLETED_CONFIG);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('defaults the notification scope to the event type', async () => {
    await notifyReactor(completedEvent(), COMPLETED_CONFIG);

    expect(sent().scope).toBe('warp.run.completed');
  });
});

// ─── Placeholder interpolation ───────────────────────────────────────────────

describe('{{field}} interpolation', () => {
  it('substitutes payload fields into the configured body', async () => {
    await notifyReactor(completedEvent(), COMPLETED_CONFIG);

    expect(sent().title).toBe('Warp run completed');
    expect(sent().body).toBe('Run SUCCEEDED: Nightly');
  });

  it('renders the timeout chain body from its own payload fields', async () => {
    const event: BusEvent = {
      type: 'warp.run.timeout',
      issuer: PRINCIPAL,
      subject: PRINCIPAL,
      scope: 'warp',
      payload: { runId: RUN_ID, lastKnownState: 'INPROGRESS', principalDid: PRINCIPAL },
    };

    await notifyReactor(event, {
      title: 'Warp run timed out',
      body: 'Run {{runId}} last seen {{lastKnownState}}',
    });

    expect(sent().body).toBe(`Run ${RUN_ID} last seen INPROGRESS`);
  });

  it('tolerates whitespace inside the braces', async () => {
    await notifyReactor(completedEvent(), { body: 'Run {{ state }}' });

    expect(sent().body).toBe('Run SUCCEEDED');
  });

  it('substitutes numbers and booleans', async () => {
    await notifyReactor(completedEvent({ attempts: 3, retryable: false }), {
      body: '{{attempts}} attempts, retryable {{retryable}}',
    });

    expect(sent().body).toBe('3 attempts, retryable false');
  });

  it('drops a placeholder whose payload field is absent rather than leaking it', async () => {
    await notifyReactor(completedEvent({ title: null }), COMPLETED_CONFIG);

    expect(sent().body).toBe('Run SUCCEEDED:');
  });

  it('drops a placeholder pointing at a nested object rather than stringifying it', async () => {
    await notifyReactor(completedEvent(), { body: 'msg {{statusMessage}}' });

    expect(sent().body).toBe('msg');
  });

  it('leaves a body with no placeholders untouched', async () => {
    await notifyReactor(completedEvent(), { title: 'Static title', body: 'Static body' });

    expect(sent().title).toBe('Static title');
    expect(sent().body).toBe('Static body');
  });

  it('omits a field that interpolates to nothing at all', async () => {
    await notifyReactor(completedEvent(), { title: '{{missing}}', body: '{{alsoMissing}}' });

    expect(sent().title).toBeUndefined();
    expect(sent().body).toBeUndefined();
  });
});

// ─── Payload pass-through ────────────────────────────────────────────────────

describe('notification data', () => {
  it('carries the full event payload so a woken agent can act without a read-back', async () => {
    await notifyReactor(completedEvent(), COMPLETED_CONFIG);

    expect(sent().data).toMatchObject({
      runId: RUN_ID,
      state: 'SUCCEEDED',
      eventType: 'warp.run.completed',
      subject: PRINCIPAL,
      issuer: PRINCIPAL,
    });
  });
});
