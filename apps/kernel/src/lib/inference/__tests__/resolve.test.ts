import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockInsertValuesReturning, mockInsertValues,
  mockUpdateSetWhere, mockUpdateSet,
  mockSelectWhereLimit, mockSelectWhere, mockSelectFrom,
  mockDbSelect, mockDbInsert, mockDbUpdate,
} = vi.hoisted(() => {
  const mockInsertValuesReturning = vi.fn();
  const mockInsertValues = vi.fn(() => ({ returning: mockInsertValuesReturning }));
  const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateSetWhere }));
  const mockSelectWhereLimit = vi.fn();
  const mockSelectWhere = vi.fn(() => ({ limit: mockSelectWhereLimit }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockDbInsert = vi.fn(() => ({ values: mockInsertValues }));
  const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  return {
    mockInsertValuesReturning, mockInsertValues,
    mockUpdateSetWhere, mockUpdateSet,
    mockSelectWhereLimit, mockSelectWhere, mockSelectFrom,
    mockDbSelect, mockDbInsert, mockDbUpdate,
  };
});

vi.mock('@/src/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
  assets: {},
  inferenceSessions: {},
  inferenceAttestations: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

const mockPublishContentEvent = vi.hoisted(() => vi.fn());
vi.mock('@imajin/dfos', () => ({
  publishContentEvent: mockPublishContentEvent,
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'attestid123456') }));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'deadbeef'),
  })),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

const { mockSignSync, mockGetNodeSigningIdentity, MOCK_NODE_IDENTITY } = vi.hoisted(() => {
  const identity = {
    privateKeyHex: 'aaaa'.repeat(16),
    senderPubkey: 'bbbb'.repeat(16),
    senderDid: 'did:imajin:bbbbbbbbbbbbbbbb',
  };
  return {
    mockSignSync: vi.fn(() => 'deadsignature0123456789abcdef'),
    mockGetNodeSigningIdentity: vi.fn(() => identity),
    MOCK_NODE_IDENTITY: identity,
  };
});

vi.mock('@imajin/auth', () => ({
  canonicalize: vi.fn(() => 'canonical-attestation-payload'),
  crypto: { signSync: mockSignSync },
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: mockGetNodeSigningIdentity,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { resolveIntent } from '../resolve';
import type { CandidateIntent, IntentVocabulary } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SUPPLY_INTENT: CandidateIntent = {
  intentType: 'supply.received',
  confidence: 0.95,
  metadata: { product: 'maize', qty: 50 },
  consentTier: 'deliberate',
};

const MOCK_RECEIPT = {
  primitiveType: 'supply.received',
  externalId: 'sup_evt_42',
  digest: 'receiptdigest',
  resolvedAt: '2026-07-13T12:00:00.000Z',
};

const VOCAB: IntentVocabulary = {
  name: 'agrifortress',
  modelProvider: 'openai',
  modelId: 'gemini-2.0-flash',
  systemPrompt: '',
  resolveConsentTier: () => 'deliberate',
  resolve: vi.fn().mockResolvedValue(MOCK_RECEIPT),
};

const MOCK_SESSION = {
  id: 'session_abc',
  ownerDid: 'did:imajin:farmer',
  vocabularyName: 'agrifortress',
  assetId: 'asset_xyz',
  status: 'resolving',
  chosenIntentType: 'supply.received',
  consentTier: 'deliberate',
  candidateIntents: [SUPPLY_INTENT],
};

const MOCK_OWNER_AUTH = {
  payload: { sessionId: 'session_abc', chosenIntentType: 'supply.received', candidateDigest: 'abc123', ts: '2026-07-13T12:00:00Z' },
  signature: 'ownerauth_sig',
  senderPubkey: 'bbbb'.repeat(16),
};

const MOCK_ATTESTATION = {
  id: 'attest_attestid123456',
  sessionId: 'session_abc',
};

function setupSelectSequence(session: object | null, assetCid: string | null) {
  // First call: load session
  mockSelectWhereLimit.mockResolvedValueOnce(session ? [session] : []);
  // Second call: load asset CID
  mockSelectWhereLimit.mockResolvedValueOnce(assetCid ? [{ cid: assetCid }] : []);
}

beforeEach(() => {
  // resetAllMocks flushes any unconsumed mockResolvedValueOnce queues in
  // addition to clearing call history — prevents cross-test queue leakage.
  vi.resetAllMocks();

  mockUpdateSet.mockImplementation(() => ({ where: mockUpdateSetWhere }));
  mockUpdateSetWhere.mockResolvedValue(undefined);
  mockSelectFrom.mockImplementation(() => ({ where: mockSelectWhere }));
  mockSelectWhere.mockImplementation(() => ({ limit: mockSelectWhereLimit }));
  mockInsertValues.mockImplementation(() => ({ returning: mockInsertValuesReturning }));
  mockInsertValuesReturning.mockResolvedValue([MOCK_ATTESTATION]);
  mockPublishContentEvent.mockResolvedValue({ eventId: 'dfos_123' });
  mockDbSelect.mockImplementation(() => ({ from: mockSelectFrom }));
  mockDbInsert.mockImplementation(() => ({ values: mockInsertValues }));
  mockDbUpdate.mockImplementation(() => ({ set: mockUpdateSet }));

  vi.mocked(VOCAB.resolve).mockResolvedValue(MOCK_RECEIPT);
  mockSignSync.mockReturnValue('deadsignature0123456789abcdef');
  mockGetNodeSigningIdentity.mockReturnValue(MOCK_NODE_IDENTITY);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveIntent', () => {
  describe('session validation', () => {
    it('throws when session is not found', async () => {
      mockSelectWhereLimit.mockResolvedValueOnce([]); // session not found

      await expect(resolveIntent('session_abc', 'did:imajin:farmer', VOCAB))
        .rejects.toThrow('not found');
    });

    it('throws when session ownerDid does not match', async () => {
      mockSelectWhereLimit.mockResolvedValueOnce([{ ...MOCK_SESSION, ownerDid: 'did:imajin:other' }]);

      await expect(resolveIntent('session_abc', 'did:imajin:farmer', VOCAB))
        .rejects.toThrow('owner mismatch');
    });

    it('throws when session is not in resolving state', async () => {
      mockSelectWhereLimit.mockResolvedValueOnce([{ ...MOCK_SESSION, status: 'pending_confirm' }]);

      await expect(resolveIntent('session_abc', 'did:imajin:farmer', VOCAB))
        .rejects.toThrow('resolving state');
    });
  });

  describe('happy path', () => {
    it('calls vocab.resolve with the chosen CandidateIntent and ownerDid', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafytest');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      expect(VOCAB.resolve).toHaveBeenCalledOnce();
      const [intent, ownerDid] = (VOCAB.resolve as ReturnType<typeof vi.fn>).mock.calls[0] as [CandidateIntent, string];
      expect(intent.intentType).toBe('supply.received');
      expect(ownerDid).toBe('did:imajin:farmer');
    });

    it('inserts an inference_attestations row with sourceCid chained to the recording', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafyrecording');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      expect(mockInsertValues).toHaveBeenCalledOnce();
      const rowArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(rowArg['sessionId']).toBe('session_abc');
      expect(rowArg['ownerDid']).toBe('did:imajin:farmer');
      expect(rowArg['intentType']).toBe('supply.received');
      expect(rowArg['consentTier']).toBe('deliberate');
      expect(rowArg['sourceCid']).toBe('bafyrecording');
      expect(rowArg['id']).toMatch(/^attest_/);
    });

    it('signs the attestation payload with node identity and stores signature + senderPubkey', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafyrecording');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      const rowArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(rowArg['signature']).toBe('deadsignature0123456789abcdef');
      expect(rowArg['senderPubkey']).toBe(MOCK_NODE_IDENTITY.senderPubkey);
    });

    it('copies ownerAuthorization from session into the attestation row', async () => {
      setupSelectSequence({ ...MOCK_SESSION, ownerAuthorization: MOCK_OWNER_AUTH }, 'bafyrecording');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      const rowArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(rowArg['ownerAuthorization']).toEqual(MOCK_OWNER_AUTH);
    });

    it('sets ownerAuthorization to null when session has none (silent tier)', async () => {
      setupSelectSequence({ ...MOCK_SESSION, ownerAuthorization: null }, 'bafytest');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      const rowArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(rowArg['ownerAuthorization']).toBeNull();
    });

    it('publishes inference.resolved DFOS event', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafytest');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      expect(mockPublishContentEvent).toHaveBeenCalledOnce();
      const { topic, payload } = mockPublishContentEvent.mock.calls[0][0] as { topic: string; payload: Record<string, unknown> };
      expect(topic).toBe('inference.resolved');
      expect(payload['intentType']).toBe('supply.received');
      expect(payload['ownerDid']).toBe('did:imajin:farmer');
    });

    it('advances session status to resolved', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafytest');

      await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      // Find the update call that sets status=resolved (last update call).
      const resolvedCall = mockUpdateSet.mock.calls.find(
        (call) => (call[0] as Record<string, unknown>)['status'] === 'resolved',
      );
      expect(resolvedCall).toBeDefined();
    });

    it('returns a ResolveResult with attestationId, intentType, primitiveType, resolvedAt', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafytest');

      const result = await resolveIntent('session_abc', 'did:imajin:farmer', VOCAB);

      expect(result.attestationId).toMatch(/^attest_/);
      expect(result.intentType).toBe('supply.received');
      expect(result.primitiveType).toBe('supply.received');
      expect(result.externalId).toBe('sup_evt_42');
      expect(result.resolvedAt).toBe('2026-07-13T12:00:00.000Z');
    });
  });

  describe('error handling', () => {
    it('marks session as failed and rethrows when vocab.resolve rejects', async () => {
      setupSelectSequence(MOCK_SESSION, null);
      vi.mocked(VOCAB.resolve).mockRejectedValueOnce(new Error('API timeout'));

      await expect(resolveIntent('session_abc', 'did:imajin:farmer', VOCAB))
        .rejects.toThrow('Vocabulary resolution failed');

      const failedCall = mockUpdateSet.mock.calls.find(
        (call) => (call[0] as Record<string, unknown>)['status'] === 'failed',
      );
      expect(failedCall).toBeDefined();
    });

    it('does not throw if DFOS publish rejects (non-fatal)', async () => {
      setupSelectSequence(MOCK_SESSION, 'bafytest');
      mockPublishContentEvent.mockRejectedValue(new Error('DFOS unavailable'));

      await expect(resolveIntent('session_abc', 'did:imajin:farmer', VOCAB)).resolves.toBeDefined();
    });
  });
});
