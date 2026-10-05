/**
 * #2565 — `createCustomRelay` awaits `createRelay` before returning so it
 * stays an honest async boundary (typescript:S7503): a rejection from relay
 * construction still rejects the caller's promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createRelayMock, createHttpPeerClientMock } = vi.hoisted(() => ({
  createRelayMock: vi.fn(),
  createHttpPeerClientMock: vi.fn(() => ({ kind: 'http-peer-client' })),
}));

vi.mock('@metalabel/dfos-web-relay', () => ({
  createRelay: createRelayMock,
  createHttpPeerClient: createHttpPeerClientMock,
}));

import { createCustomRelay } from '../create-relay';

const STORE = {} as never;

beforeEach(() => {
  createRelayMock.mockReset();
  createHttpPeerClientMock.mockClear();
});

describe('createCustomRelay', () => {
  it('resolves with the relay and wires no peer client when there are no peers', async () => {
    const relay = { app: 'relay' };
    createRelayMock.mockResolvedValue(relay);

    await expect(createCustomRelay({ store: STORE })).resolves.toBe(relay);

    expect(createRelayMock).toHaveBeenCalledWith(expect.objectContaining({ store: STORE, peerClient: undefined }));
    expect(createHttpPeerClientMock).not.toHaveBeenCalled();
  });

  it('wires an HTTP peer client when peers are configured', async () => {
    createRelayMock.mockResolvedValue({ app: 'relay' });
    const peers = [{ url: 'https://peer.example' }] as never;

    await createCustomRelay({ store: STORE, peers });

    expect(createHttpPeerClientMock).toHaveBeenCalledTimes(1);
    expect(createRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({ peers, peerClient: { kind: 'http-peer-client' } }),
    );
  });

  it('rejects when relay construction rejects', async () => {
    createRelayMock.mockRejectedValue(new Error('relay boot failed'));

    await expect(createCustomRelay({ store: STORE })).rejects.toThrow('relay boot failed');
  });

  it('rejects (rather than throwing synchronously) when relay construction throws', async () => {
    createRelayMock.mockImplementation(() => {
      throw new Error('sync boom');
    });

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = createCustomRelay({ store: STORE });
    }).not.toThrow();
    await expect(pending).rejects.toThrow('sync boom');
  });
});
