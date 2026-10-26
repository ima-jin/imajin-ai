import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  findBundle: vi.fn(),
  findPreKey: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    query: {
      publicKeys: { findFirst: mocks.findBundle },
      preKeys: { findFirst: mocks.findPreKey },
    },
    update: mocks.update,
  },
  publicKeys: { did: 'did' },
  preKeys: { did: 'did', id: 'id' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

import { GET } from '../route';

const did = 'did:imajin:alice';
const bundle = {
  did,
  identityKey: 'public-identity-key',
  signedPreKey: 'public-signed-pre-key',
  signature: 'public-signature',
};

function lookup(value = did) {
  return GET(new NextRequest(`https://example.test/chat/api/keys/${value}`), {
    params: Promise.resolve({ did: value }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findBundle.mockResolvedValue(bundle);
  mocks.findPreKey.mockResolvedValue(null);
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockResolvedValue(undefined);
});

describe('public key bundle lookup', () => {
  it('returns public keys without claiming message encryption', async () => {
    const response = await lookup();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...bundle, oneTimePreKey: null });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('marks an available one-time pre-key as used', async () => {
    mocks.findPreKey.mockResolvedValue({ id: 'pk1', key: 'public-pre-key', used: false });

    const response = await lookup();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...bundle, oneTimePreKey: 'public-pre-key' });
    expect(mocks.set).toHaveBeenCalledWith({ used: true });
    expect(mocks.where).toHaveBeenCalledOnce();
  });

  it('does not update an already-used pre-key', async () => {
    mocks.findPreKey.mockResolvedValue({ id: 'pk1', key: 'public-pre-key', used: true });

    expect((await lookup()).status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid DID before looking up keys', async () => {
    const response = await lookup('invalid');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid DID format' });
    expect(mocks.findBundle).not.toHaveBeenCalled();
  });

  it('returns not found when no bundle exists', async () => {
    mocks.findBundle.mockResolvedValue(null);

    const response = await lookup();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No keys found for this DID' });
    expect(mocks.findPreKey).not.toHaveBeenCalled();
  });

  it('returns a generic error if lookup fails', async () => {
    mocks.findBundle.mockRejectedValue(new Error('lookup unavailable'));

    const response = await lookup();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to get keys' });
    expect(mocks.logError).toHaveBeenCalledOnce();
  });
});
