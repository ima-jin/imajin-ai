/**
 * The `attestation-notify` reactor (#1820).
 *
 * `attestation.created` fires for every attestation the platform writes, most
 * of which are one-shot system attestations with no counterparty action
 * pending. This reactor must only notify for the genuine "awaiting your
 * counter-signature" case, and must no-op cleanly for a self-attestation or a
 * subject that resolves to an unclaimed profile stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/notify', () => ({ send: mockSend }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// Fake postgres.js tagged-template client — see packages/bus/AGENTS.md.
const { fakeSql, setProfileRow, setShouldThrow } = vi.hoisted(() => {
  let profileRow: Record<string, unknown> | null = null;
  let shouldThrow = false;
  const fakeSql = (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    if (shouldThrow) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(profileRow ? [profileRow] : []);
  };
  return {
    fakeSql,
    setProfileRow: (row: Record<string, unknown> | null) => {
      profileRow = row;
    },
    setShouldThrow: (value: boolean) => {
      shouldThrow = value;
    },
  };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { attestationNotifyReactor } from '../src/reactors/attestation-notify';
import type { BusEvent } from '../src/types';

const ISSUER = 'did:imajin:alice';
const SUBJECT = 'did:imajin:bob';
const ATTESTATION_ID = 'att_001';

function makeEvent(overrides: Partial<BusEvent> = {}, payloadOverrides: Record<string, unknown> = {}): BusEvent {
  return {
    type: 'attestation.created',
    issuer: ISSUER,
    subject: SUBJECT,
    scope: 'auth',
    payload: {
      attestationId: ATTESTATION_ID,
      type: 'delivery.receipt',
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      contextId: null,
      contextType: null,
      pendingSignature: true,
      ...payloadOverrides,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  setProfileRow({ claim_status: 'claimed', contact_email: 'bob@example.com' });
  setShouldThrow(false);
});

describe('routing a genuine pending-signature attestation', () => {
  it('sends attest.pending_signature to the subject', async () => {
    await attestationNotifyReactor(makeEvent(), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.to).toBe(SUBJECT);
    expect(sent.scope).toBe('attest.pending_signature');
  });

  it('carries attestationId, type, and originUrl in data for the deep link', async () => {
    await attestationNotifyReactor(
      makeEvent({}, { originUrl: 'https://xprize.example.com' }),
      {},
    );

    const sent = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.data).toEqual({
      attestationId: ATTESTATION_ID,
      type: 'delivery.receipt',
      originUrl: 'https://xprize.example.com',
    });
  });

  it('omits originUrl when it was not derivable at creation time', async () => {
    await attestationNotifyReactor(makeEvent(), {});

    const sent = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect((sent.data as Record<string, unknown>).originUrl).toBeUndefined();
  });
});

describe('skip: self-attestation', () => {
  it('does not notify when issuer === subject', async () => {
    await attestationNotifyReactor(makeEvent({ issuer: SUBJECT, subject: SUBJECT }), {});

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('realistic supply.received delivery attestation (#1820)', () => {
  const SUPPLIER = 'did:imajin:supplier';
  const RECIPIENT = 'did:imajin:recipient';

  it('fires notify for a bilateral delivery attestation naming a distinct counterparty', async () => {
    await attestationNotifyReactor(
      makeEvent(
        { issuer: SUPPLIER, subject: RECIPIENT },
        {
          type: 'supply.received',
          issuerDid: SUPPLIER,
          subjectDid: RECIPIENT,
          pendingSignature: true,
        },
      ),
      {},
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.to).toBe(RECIPIENT);
    expect((sent.data as Record<string, unknown>).type).toBe('supply.received');
  });

  it('does not fire when the delivery is self-attested (no distinct counterparty)', async () => {
    await attestationNotifyReactor(
      makeEvent(
        { issuer: SUPPLIER, subject: SUPPLIER },
        { type: 'supply.received', issuerDid: SUPPLIER, subjectDid: SUPPLIER, pendingSignature: true },
      ),
      {},
    );

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('does not fire for one-shot system attestations flowing through the internal route (#1820)', () => {
  it.each([
    ['vouch', ISSUER, SUBJECT],
    ['identity.created', ISSUER, SUBJECT],
    ['connection.accepted', ISSUER, SUBJECT],
  ] as const)('skips %s (pendingSignature always false via the internal route)', async (type, issuer, subject) => {
    await attestationNotifyReactor(
      makeEvent({ issuer, subject }, { type, issuerDid: issuer, subjectDid: subject, pendingSignature: false }),
      {},
    );

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('skip: not awaiting a signature', () => {
  it('does not notify one-shot system attestations (pendingSignature: false)', async () => {
    await attestationNotifyReactor(makeEvent({}, { pendingSignature: false }), {});

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not notify when pendingSignature is absent from the payload', async () => {
    const event = makeEvent();
    delete (event.payload as Record<string, unknown>).pendingSignature;

    await attestationNotifyReactor(event, {});

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('skip: unclaimed profile stub', () => {
  it('does not notify a subject resolving to an unclaimed stub with no email', async () => {
    setProfileRow({ claim_status: 'unclaimed', contact_email: null });

    await attestationNotifyReactor(makeEvent(), {});

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still notifies an unclaimed stub that somehow has an email on file', async () => {
    setProfileRow({ claim_status: 'unclaimed', contact_email: 'stub@example.com' });

    await attestationNotifyReactor(makeEvent(), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('notifies a claimed profile normally', async () => {
    setProfileRow({ claim_status: 'claimed', contact_email: 'bob@example.com' });

    await attestationNotifyReactor(makeEvent(), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('fails open (still notifies) when the profile lookup errors', async () => {
    setShouldThrow(true);

    await attestationNotifyReactor(makeEvent(), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('notifies when no profile row exists at all', async () => {
    setProfileRow(null);

    await attestationNotifyReactor(makeEvent(), {});

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
