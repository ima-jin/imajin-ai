import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDecodeJwsUnsafe, mockDecodeMultikey, mockVerifyAuthToken, mockIsRelayPeerAttested } = vi.hoisted(() => ({
  mockDecodeJwsUnsafe: vi.fn(),
  mockDecodeMultikey: vi.fn(),
  mockVerifyAuthToken: vi.fn(),
  mockIsRelayPeerAttested: vi.fn(),
}));

vi.mock('@metalabel/dfos-protocol/crypto', () => ({
  decodeJwsUnsafe: mockDecodeJwsUnsafe,
}));

vi.mock('@metalabel/dfos-protocol/chain', () => ({
  decodeMultikey: mockDecodeMultikey,
}));

vi.mock('@metalabel/dfos-protocol/credentials', () => ({
  verifyAuthToken: mockVerifyAuthToken,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('../peer-attestations', () => ({
  isRelayPeerAttested: mockIsRelayPeerAttested,
}));

import { parseDfosAuthorization, verifyDfosWrite, DFOS_AUTH_SCHEME } from '../dfos-write-auth';

const PEER_DID = 'did:dfos:peer-abc';
const KEY_ID = 'key_xyz';
const KID = `${PEER_DID}#${KEY_ID}`;
const AUDIENCE = 'did:dfos:relay-under-test';
const PUBLIC_KEY_MULTIBASE = 'z6Mkexample';
const PUBLIC_KEY_BYTES = new Uint8Array([1, 2, 3]);

function makeDeps(overrides?: { authKeys?: unknown; audience?: string | null }) {
  const authKeys = overrides && 'authKeys' in overrides
    ? overrides.authKeys
    : [{ id: KEY_ID, publicKeyMultibase: PUBLIC_KEY_MULTIBASE }];
  const audience = overrides && 'audience' in overrides ? overrides.audience : AUDIENCE;

  return {
    identities: { resolveAuthKeys: vi.fn().mockResolvedValue(authKeys) },
    getAudience: vi.fn().mockResolvedValue(audience),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecodeJwsUnsafe.mockReturnValue({ header: { kid: KID }, payload: {} });
  mockDecodeMultikey.mockReturnValue({ keyBytes: PUBLIC_KEY_BYTES, codec: 0xed });
  mockVerifyAuthToken.mockReturnValue({ iss: PEER_DID, aud: AUDIENCE, exp: 1, iat: 0, kid: KID });
  mockIsRelayPeerAttested.mockResolvedValue(true);
});

describe('DFOS_AUTH_SCHEME', () => {
  it('is the literal "DFOS" scheme name', () => {
    expect(DFOS_AUTH_SCHEME).toBe('DFOS');
  });
});

describe('parseDfosAuthorization', () => {
  it('extracts the proof from a DFOS-scheme header', () => {
    expect(parseDfosAuthorization('DFOS abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null for a missing header', () => {
    expect(parseDfosAuthorization(null)).toBeNull();
  });

  it('returns null for Bearer scheme — falls through to Imajin auth', () => {
    expect(parseDfosAuthorization('Bearer some-token')).toBeNull();
  });

  it('returns null for a bare scheme with no proof', () => {
    expect(parseDfosAuthorization('DFOS')).toBeNull();
    expect(parseDfosAuthorization('DFOS ')).toBeNull();
  });

  it('is case-sensitive on the scheme name', () => {
    expect(parseDfosAuthorization('dfos abc')).toBeNull();
  });
});

describe('verifyDfosWrite', () => {
  it('valid proof + attested peer → ok with the peer DID', async () => {
    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: true, did: PEER_DID });
    expect(mockVerifyAuthToken).toHaveBeenCalledWith({
      token: 'proof-token',
      publicKey: PUBLIC_KEY_BYTES,
      audience: AUDIENCE,
    });
    expect(mockIsRelayPeerAttested).toHaveBeenCalledWith(PEER_DID);
  });

  it('valid proof + non-attested peer → 403 peer_not_attested', async () => {
    mockIsRelayPeerAttested.mockResolvedValue(false);

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'peer_not_attested', status: 403 });
  });

  it('malformed token (no decodable kid) → 401 invalid_proof', async () => {
    mockDecodeJwsUnsafe.mockReturnValue(null);

    const result = await verifyDfosWrite('garbage', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
    expect(mockIsRelayPeerAttested).not.toHaveBeenCalled();
  });

  it('kid missing the DID#key separator → 401 invalid_proof', async () => {
    mockDecodeJwsUnsafe.mockReturnValue({ header: { kid: 'not-a-valid-kid' }, payload: {} });

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
  });

  it('unknown signer (relay has never seen this DID) → 401 invalid_proof', async () => {
    const result = await verifyDfosWrite('proof-token', makeDeps({ authKeys: undefined }));

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
    expect(mockVerifyAuthToken).not.toHaveBeenCalled();
  });

  it('key id not among the DID\'s current auth keys → 401 invalid_proof', async () => {
    const result = await verifyDfosWrite(
      'proof-token',
      makeDeps({ authKeys: [{ id: 'some-other-key', publicKeyMultibase: PUBLIC_KEY_MULTIBASE }] }),
    );

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
  });

  it('bad signature (verifyAuthToken throws) → 401 invalid_proof, regardless of attestation', async () => {
    mockVerifyAuthToken.mockImplementation(() => {
      throw new Error('signature mismatch');
    });

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
    expect(mockIsRelayPeerAttested).not.toHaveBeenCalled();
  });

  it('expired token (verifyAuthToken throws) → 401 invalid_proof', async () => {
    mockVerifyAuthToken.mockImplementation(() => {
      throw new Error('token expired');
    });

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
  });

  it('wrong audience (verifyAuthToken throws) → 401 invalid_proof', async () => {
    mockVerifyAuthToken.mockImplementation(() => {
      throw new Error('audience mismatch');
    });

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
  });

  it('iss in the verified payload disagreeing with the resolved DID → 401 invalid_proof', async () => {
    mockVerifyAuthToken.mockReturnValue({ iss: 'did:dfos:someone-else', aud: AUDIENCE, exp: 1, iat: 0, kid: KID });

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
  });

  it('relay has no DFOS identity yet (no audience) → 401 invalid_proof, fails closed', async () => {
    const result = await verifyDfosWrite('proof-token', makeDeps({ audience: null }));

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
    expect(mockVerifyAuthToken).not.toHaveBeenCalled();
  });

  it('malformed publicKeyMultibase (decodeMultikey throws) → 401 invalid_proof', async () => {
    mockDecodeMultikey.mockImplementation(() => {
      throw new Error('bad multibase');
    });

    const result = await verifyDfosWrite('proof-token', makeDeps());

    expect(result).toEqual({ ok: false, error: 'invalid_proof', status: 401 });
  });
});
