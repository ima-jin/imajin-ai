/**
 * The `payment-request-notify` reactor (#2212, child of #2206).
 *
 * Covers: recipient notification on `.issued` (DID vs stub email-target
 * branching, #1834/#1839), issuer+recipient fan-out on `.paid`/`.settled`,
 * recipient-only on `.voided`, issuer-only on `.recipient_claimed`, and the
 * (payment_request, event_type, target) idempotency guard against replays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/notify', () => ({ send: mockSend }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

interface FakeState {
  paymentRequest: Record<string, unknown> | null;
  inviteEmail: string | null;
  profileName: string | null;
  notifiedKeys: Set<string>;
  throwOnPaymentRequest: boolean;
}

const { state, fakeSql, resetState } = vi.hoisted(() => {
  const state: FakeState = {
    paymentRequest: null,
    inviteEmail: null,
    profileName: null,
    notifiedKeys: new Set<string>(),
    throwOnPaymentRequest: false,
  };

  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');

    if (text.includes('FROM pay.payment_request')) {
      if (state.throwOnPaymentRequest) return Promise.reject(new Error('connection refused'));
      return Promise.resolve(state.paymentRequest ? [state.paymentRequest] : []);
    }

    if (text.includes('FROM profile.profiles')) {
      return Promise.resolve(state.profileName ? [{ display_name: state.profileName }] : []);
    }

    if (text.includes('FROM connections.invites')) {
      return Promise.resolve(state.inviteEmail ? [{ to_email: state.inviteEmail }] : []);
    }

    if (text.includes('INSERT INTO kernel.payment_request_notifications')) {
      const [, paymentRequestId, eventType, targetDid] = values as [string, string, string, string];
      const key = `${paymentRequestId}:${eventType}:${targetDid}`;
      if (state.notifiedKeys.has(key)) return Promise.resolve([]);
      state.notifiedKeys.add(key);
      return Promise.resolve([{ id: 'row' }]);
    }

    return Promise.resolve([]);
  };

  return {
    state,
    fakeSql,
    resetState: () => {
      state.paymentRequest = null;
      state.inviteEmail = null;
      state.profileName = null;
      state.notifiedKeys = new Set();
      state.throwOnPaymentRequest = false;
    },
  };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { paymentRequestNotifyReactor } from '../src/reactors/payment-request-notify';
import type { BusEvent } from '../src/types';

const ISSUER = 'did:imajin:issuer';
const RECIPIENT = 'did:imajin:recipient';
const STUB = 'did:imajin:stub123';
const PAYMENT_REQUEST_ID = 'pr_001';

function paymentRequestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer_did: ISSUER,
    recipient_did: RECIPIENT,
    recipient_stub_id: null,
    total_amount: 1999,
    currency: 'USD',
    kind: 'invoice',
    ...overrides,
  };
}

function makeEvent(type: BusEvent['type'], payload: Record<string, unknown> = {}): BusEvent {
  return {
    type,
    issuer: ISSUER,
    subject: RECIPIENT,
    scope: 'pay',
    payload: { paymentRequestId: PAYMENT_REQUEST_ID, ...payload },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  resetState();
});

describe('payment_request.issued', () => {
  it('notifies a known DID recipient with in-app+email (no explicit email override)', async () => {
    state.paymentRequest = paymentRequestRow();
    state.profileName = 'Acme Co';

    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.to).toBe(RECIPIENT);
    expect(sent.scope).toBe('pay:payment_request-issued');
    const data = sent.data as Record<string, unknown>;
    expect(data.email).toBeUndefined();
    expect(data.stub).toBeUndefined();
    expect(data.issuerName).toBe('Acme Co');
  });

  it('resolves the stub invite email and marks data.stub for a claimable-stub recipient', async () => {
    state.paymentRequest = paymentRequestRow({ recipient_did: null, recipient_stub_id: STUB });
    state.inviteEmail = 'invitee@example.com';

    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.to).toBe(STUB);
    const data = sent.data as Record<string, unknown>;
    expect(data.email).toBe('invitee@example.com');
    expect(data.stub).toBe(true);
  });

  it('skips sending when no invite email can be resolved for a stub recipient', async () => {
    state.paymentRequest = paymentRequestRow({ recipient_did: null, recipient_stub_id: STUB });
    state.inviteEmail = null;

    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('no-ops when the payment_request row cannot be found', async () => {
    state.paymentRequest = null;

    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('no-ops when paymentRequestId is missing from the payload', async () => {
    const event = makeEvent('payment_request.issued');
    delete (event.payload as Record<string, unknown>).paymentRequestId;

    await paymentRequestNotifyReactor(event, {});

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('no-ops (never throws) when the payment_request lookup errors', async () => {
    state.throwOnPaymentRequest = true;

    await expect(paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {})).resolves.toBeUndefined();

    // Lookup failure means we cannot resolve a recipient at all — honest no-op, not a crash.
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('payment_request.paid', () => {
  it('notifies both the issuer and the recipient', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.paid'), {});

    expect(mockSend).toHaveBeenCalledTimes(2);
    const [issuerCall, recipientCall] = mockSend.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(issuerCall.to).toBe(ISSUER);
    expect((issuerCall.data as Record<string, unknown>).role).toBe('issuer');
    expect(recipientCall.to).toBe(RECIPIENT);
    expect((recipientCall.data as Record<string, unknown>).role).toBe('recipient');
  });

  it('branches the recipient leg to the stub invite email when still unclaimed', async () => {
    state.paymentRequest = paymentRequestRow({ recipient_did: null, recipient_stub_id: STUB });
    state.inviteEmail = 'invitee@example.com';

    await paymentRequestNotifyReactor(makeEvent('payment_request.paid'), {});

    const recipientCall = mockSend.mock.calls[1][0] as Record<string, unknown>;
    expect(recipientCall.to).toBe(STUB);
    expect((recipientCall.data as Record<string, unknown>).email).toBe('invitee@example.com');
  });
});

describe('payment_request.settled', () => {
  it('carries the settlement method through to both issuer and recipient notifications', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.settled', { method: 'stripe' }), {});

    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const call of mockSend.mock.calls) {
      expect((call[0] as Record<string, unknown>).data).toMatchObject({ method: 'stripe' });
    }
  });

  it('defaults method to manual when absent from the payload', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.settled'), {});

    const issuerCall = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect((issuerCall.data as Record<string, unknown>).method).toBe('manual');
  });
});

describe('payment_request.voided', () => {
  it('notifies only the recipient', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.voided'), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect((mockSend.mock.calls[0][0] as Record<string, unknown>).to).toBe(RECIPIENT);
  });
});

describe('payment_request.recipient_claimed', () => {
  it('notifies only the issuer', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.recipient_claimed'), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect((mockSend.mock.calls[0][0] as Record<string, unknown>).to).toBe(ISSUER);
  });
});

describe('idempotency (#2212 — replays must not double-send)', () => {
  it('does not re-send the same (payment_request, event_type, recipient) notification twice', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});
    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('treats issuer and recipient legs of the same event as distinct dedup keys', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.paid'), {});
    await paymentRequestNotifyReactor(makeEvent('payment_request.paid'), {});

    // Two distinct targets (issuer, recipient) on the first call; the replay sends nothing.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('allows a later, different event type for the same payment_request and recipient', async () => {
    state.paymentRequest = paymentRequestRow();

    await paymentRequestNotifyReactor(makeEvent('payment_request.issued'), {});
    await paymentRequestNotifyReactor(makeEvent('payment_request.voided'), {});

    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
