import { describe, it, expect, vi } from 'vitest';

// Log entries are fake JWS strings of the form `<cid>|<documentCID>` so the
// store's decode step can be exercised without real signed operations.
vi.mock('@metalabel/dfos-protocol/crypto', () => ({
  decodeJwsUnsafe: (jws: string) => {
    const [cid, documentCID] = jws.split('|');
    return {
      header: { cid },
      payload: { documentCID: documentCID || undefined, did: 'did:imajin:signer', createdAt: '2026-01-01T00:00:00Z' },
    };
  },
}));

import { PostgresRelayStore } from '../postgres-store';

function storeWithLog(log: string[]): PostgresRelayStore {
  const store = new PostgresRelayStore({} as never);
  vi.spyOn(store, 'getContentChain').mockResolvedValue({
    contentId: 'content1',
    genesisCID: 'genesis',
    log,
    state: { creatorDID: 'did:imajin:creator' },
    lastCreatedAt: '',
  } as never);
  return store;
}

function jsonBlob(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('PostgresRelayStore.getDocuments — blob reads', () => {
  it('keeps page order even when a later blob resolves before an earlier one', async () => {
    const store = storeWithLog(['op1|docA', 'op2|docB', 'op3|docC']);
    vi.spyOn(store, 'getBlob').mockImplementation(async ({ documentCID }) => {
      // The first document is the slowest to arrive.
      await new Promise((resolve) => setTimeout(resolve, documentCID === 'docA' ? 20 : 1));
      return jsonBlob({ name: documentCID });
    });

    const { documents, cursor } = await store.getDocuments('content1', { limit: 3 });

    expect(documents.map((d) => d.operationCID)).toEqual(['op1', 'op2', 'op3']);
    expect(documents.map((d) => d.document)).toEqual([{ name: 'docA' }, { name: 'docB' }, { name: 'docC' }]);
    expect(cursor).toBe('op3');
  });

  it('returns a null document for an entry without a documentCID or with a missing blob', async () => {
    const store = storeWithLog(['op1', 'op2|docB']);
    vi.spyOn(store, 'getBlob').mockResolvedValue(undefined);

    const { documents, cursor } = await store.getDocuments('content1', { limit: 10 });

    expect(documents.map((d) => d.document)).toEqual([null, null]);
    expect(cursor).toBeNull();
  });

  it('rejects when a blob read fails, rather than returning a partial page', async () => {
    const store = storeWithLog(['op1|docA', 'op2|docB']);
    vi.spyOn(store, 'getBlob').mockImplementation(async ({ documentCID }) => {
      if (documentCID === 'docB') throw new Error('blob store down');
      return jsonBlob({ name: documentCID });
    });

    await expect(store.getDocuments('content1', { limit: 2 })).rejects.toThrow('blob store down');
  });

  it('returns an empty page when the content chain does not exist', async () => {
    const store = new PostgresRelayStore({} as never);
    vi.spyOn(store, 'getContentChain').mockResolvedValue(undefined);

    await expect(store.getDocuments('missing', { limit: 5 })).resolves.toEqual({ documents: [], cursor: null });
  });
});
