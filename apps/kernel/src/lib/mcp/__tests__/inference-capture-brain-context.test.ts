/**
 * Regression test for #1762 — `inference_capture` must forward the caller's
 * `appDid` (from `McpToolContext`) into `infer()`'s credential context, not
 * just the bare owner DID.
 *
 * Before the fix, `infer(inferCtx, vocab, ctx.did)` passed a bare string,
 * which `resolveBrain` treats as `{ ownerDid: ctx.did }` with no `appDid` —
 * silently making the app/org-registrant-DID walk (added for #1621/#1624)
 * unreachable for every MCP-driven capture, even though the MCP tool context
 * always carries the authenticated app DID.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const { mockInsertValues } = vi.hoisted(() => ({
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/db', () => ({
  db: { insert: () => ({ values: mockInsertValues }) },
  inferenceSessions: {},
  inferenceAttestations: {},
}));

const mockGatherContext = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/inference/context', () => ({ gatherContext: mockGatherContext }));

const mockInfer = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/inference/policy', () => ({ infer: mockInfer }));

const mockResolveConsentGate = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/inference/consent', () => ({ resolveConsentGate: mockResolveConsentGate }));

vi.mock('@/src/lib/inference/resolve', () => ({ resolveIntent: vi.fn() }));

const VOCAB = { name: 'imajin' };
vi.mock('@/src/lib/inference/vocabulary', () => ({
  getVocabulary: vi.fn(() => VOCAB),
  listVocabularyNames: vi.fn(() => ['imajin']),
}));

const mockCreateAsset = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: mockCreateAsset }));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'mockednanoid16') }));

// ─── Subject ───────────────────────────────────────────────────────────────

import { inferenceTools } from '../tools/inference';

const captureTool = inferenceTools.find((t) => t.name === 'inference_capture');
if (!captureTool) throw new Error('inference_capture tool not registered');

const OWNER_DID = 'did:imajin:6JSKE52ySFid2x7ejUEw6VV1NyJA1idfVKpg3We9b5Nc';
const APP_DID = 'did:imajin:6g3x2BfkAzGSAkgJgxmL2aMfedknNidxHbejDbDfeu8a';

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertValues.mockResolvedValue(undefined);
  mockCreateAsset.mockResolvedValue({ asset: { id: 'asset_x' } });
  mockGatherContext.mockResolvedValue({ sessionId: 'session_x', transcript: '' });
  mockInfer.mockResolvedValue([{ intentType: 'noop', confidence: 1, metadata: {}, consentTier: 'silent' }]);
  mockResolveConsentGate.mockResolvedValue('pending_confirm');
});

describe('inference_capture — brain credential context (#1762)', () => {
  it('forwards both ownerDid and appDid to infer(), not a bare owner DID string', async () => {
    const ctx = { did: OWNER_DID, appDid: APP_DID, scopes: new Set(['inference:write']) };

    await captureTool.handler({ text: 'hello' }, ctx);

    expect(mockInfer).toHaveBeenCalledTimes(1);
    const credentialContext = mockInfer.mock.calls[0][2];
    expect(credentialContext).toEqual({ ownerDid: OWNER_DID, appDid: APP_DID });
  });

  it('never passes a bare string as the credential context', async () => {
    const ctx = { did: OWNER_DID, appDid: APP_DID, scopes: new Set(['inference:write']) };

    await captureTool.handler({ text: 'hello' }, ctx);

    const credentialContext = mockInfer.mock.calls[0][2];
    expect(typeof credentialContext).not.toBe('string');
  });
});
