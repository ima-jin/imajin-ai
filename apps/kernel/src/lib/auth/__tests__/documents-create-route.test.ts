import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  const returningMock = vi.fn();
  const valuesMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const updateWhereMock = vi.fn();
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  return {
    requireAuthMock: vi.fn(),
    verifyDocumentSignatureTokenMock: vi.fn(),
    publishMock: vi.fn(),
    whereMock,
    selectMock,
    insertMock,
    returningMock,
    updateMock,
    updateWhereMock,
  };
});

vi.mock('@/src/lib/auth/middleware', () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock('@/src/lib/auth/document-signatures', () => ({
  verifyDocumentSignatureToken: mocks.verifyDocumentSignatureTokenMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: vi.fn(() => ({})),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    insert: mocks.insertMock,
    update: mocks.updateMock,
  },
  attestations: {},
  attestationSignatures: {},
  identities: {},
  assets: {},
}));

import { POST } from '../../../../app/auth/api/documents/route';

function makeWhereResult(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & { limit: (n: number) => Promise<unknown[]> };
  promise.limit = vi.fn().mockResolvedValue(rows);
  return promise;
}

describe('POST /auth/api/documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock
      .mockImplementationOnce(() =>
        makeWhereResult([
          { id: 'asset_1', ownerDid: 'did:imajin:alice', hash: 'bafy-hash-1' },
        ])
      )
      .mockImplementationOnce(() =>
        makeWhereResult([
          { publicKey: 'f'.repeat(64), handle: 'alice', name: 'Alice' },
        ])
      )
      .mockImplementationOnce(() =>
        makeWhereResult([
          { id: 'sig_1', signerDid: 'did:imajin:alice', status: 'signed' },
          { id: 'sig_2', signerDid: 'did:imajin:bob', status: 'pending' },
          { id: 'sig_3', signerDid: 'did:imajin:carol', status: 'pending' },
        ])
      );
    mocks.returningMock.mockResolvedValueOnce([
      {
        id: 'att_123',
        issuerDid: 'did:imajin:alice',
        documentHash: 'bafy-hash-1',
      },
    ]);
    mocks.updateWhereMock.mockResolvedValue(undefined);
    mocks.requireAuthMock.mockResolvedValue({ sub: 'did:imajin:alice' });
    mocks.verifyDocumentSignatureTokenMock.mockResolvedValue(true);
    mocks.publishMock.mockResolvedValue(undefined);
  });

  it('publishes one document.created event per signer with sign URL metadata', async () => {
    const request = new Request('https://test.imajin.ai/auth/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '  Team Agreement  ',
        document_asset_id: 'asset_1',
        document_hash: 'bafy-hash-1',
        signers: ['did:imajin:bob', 'did:imajin:carol'],
        expiry: '7d',
        author_jws: 'node-signature-token',
      }),
    });

    const response = await POST(request as any);
    expect(response.status).toBe(201);

    expect(mocks.publishMock).toHaveBeenCalledTimes(2);
    const [firstEventName, firstEventBody] = mocks.publishMock.mock.calls[0] as [string, any];
    const [secondEventName, secondEventBody] = mocks.publishMock.mock.calls[1] as [string, any];

    expect(firstEventName).toBe('document.created');
    expect(secondEventName).toBe('document.created');

    expect(firstEventBody).toMatchObject({
      issuer: 'did:imajin:alice',
      subject: 'did:imajin:bob',
      scope: 'auth',
      payload: expect.objectContaining({
        title: 'Team Agreement',
        creatorName: '@alice',
        creatorDid: 'did:imajin:alice',
        documentAssetId: 'asset_1',
        signerDids: ['did:imajin:bob', 'did:imajin:carol'],
      }),
    });
    expect(secondEventBody).toMatchObject({
      issuer: 'did:imajin:alice',
      subject: 'did:imajin:carol',
      scope: 'auth',
    });

    const attestationId = firstEventBody.payload.attestationId;
    expect(typeof attestationId).toBe('string');
    expect(firstEventBody.payload.signUrl).toBe(`/auth/documents/${attestationId}`);
    expect(secondEventBody.payload.attestationId).toBe(attestationId);
    expect(secondEventBody.payload.signUrl).toBe(`/auth/documents/${attestationId}`);
  });
});
