import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sealMock, loadMock, deriveMock, generateMock, buildEventMock, sendToRelayMock, loadDidTagsMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  deriveMock: vi.fn(),
  generateMock: vi.fn(),
  buildEventMock: vi.fn(),
  sendToRelayMock: vi.fn(),
  loadDidTagsMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: sealMock, loadAndUnseal: loadMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock('../nostr-event', () => ({
  generateNostrPrivkey: generateMock,
  deriveNostrPubkey: deriveMock,
  buildKind9Event: buildEventMock,
}));
vi.mock('../relay-transport', () => ({ sendToRelay: sendToRelayMock }));
vi.mock('../did-resolver', () => ({ loadDidTags: loadDidTagsMock }));

import { VaultDelegationError } from '@/src/lib/vault/errors';
import { vaultField, generateAndSeal, getPublicKey, sendKind9 } from '../connector';

const OWNER = 'did:imajin:buzzuser';
const PRIVKEY = 'a'.repeat(64);
const PUBKEY = 'b'.repeat(64);

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  loadMock.mockReset();
  generateMock.mockReset();
  generateMock.mockReturnValue(PRIVKEY);
  deriveMock.mockReset();
  deriveMock.mockReturnValue(PUBKEY);
  buildEventMock.mockReset();
  buildEventMock.mockReturnValue({ id: 'event123' });
  sendToRelayMock.mockReset();
  sendToRelayMock.mockResolvedValue(undefined);
  loadDidTagsMock.mockReset();
  loadDidTagsMock.mockResolvedValue({});
});

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`nostr-key:${OWNER}`);
  });
});

describe('generateAndSeal (#1521 — seals via sealAndStoreV2)', () => {
  it('generates a keypair, seals the private key, and returns only the pubkey', async () => {
    const result = await generateAndSeal(OWNER);

    expect(result).toEqual({ pubkeyHex: PUBKEY });
    expect(sealMock).toHaveBeenCalledWith(vaultField(OWNER), PRIVKEY);
    // The private key must never be returned to the caller.
    expect(JSON.stringify(result)).not.toContain(PRIVKEY);
  });
});

describe('getPublicKey', () => {
  it('returns undefined when no key has been sealed', async () => {
    loadMock.mockResolvedValue(undefined);
    expect(await getPublicKey(OWNER)).toBeUndefined();
  });

  it('derives the pubkey from the sealed private key', async () => {
    loadMock.mockResolvedValue(PRIVKEY);
    expect(await getPublicKey(OWNER)).toBe(PUBKEY);
  });

  it('surfaces buzz_credential_pending when the key is sealed but no grant has arrived (#1521)', async () => {
    loadMock.mockRejectedValue(new VaultDelegationError('no active grant', { field: vaultField(OWNER), nodeDid: 'did:imajin:node' }));
    await expect(getPublicKey(OWNER)).rejects.toThrow(/buzz_credential_pending/);
  });
});

describe('sendKind9', () => {
  it('throws buzz_no_key when no key is sealed', async () => {
    loadMock.mockResolvedValue(undefined);
    await expect(sendKind9(OWNER, 'wss://relay.test', 'group1', 'hi')).rejects.toThrow(/buzz_no_key/);
    expect(sendToRelayMock).not.toHaveBeenCalled();
  });

  it('surfaces buzz_credential_pending when the key is sealed but no grant has arrived (#1521)', async () => {
    loadMock.mockRejectedValue(new VaultDelegationError('no active grant', { field: vaultField(OWNER), nodeDid: 'did:imajin:node' }));
    await expect(sendKind9(OWNER, 'wss://relay.test', 'group1', 'hi')).rejects.toThrow(/buzz_credential_pending/);
    expect(sendToRelayMock).not.toHaveBeenCalled();
  });

  it('builds and sends the event, returning the relay-confirmed id', async () => {
    loadMock.mockResolvedValue(PRIVKEY);

    const result = await sendKind9(OWNER, 'wss://relay.test', 'group1', 'hello');

    expect(result).toEqual({ eventId: 'event123' });
    expect(buildEventMock).toHaveBeenCalledWith(PUBKEY, 'group1', 'hello', PRIVKEY, {});
    expect(sendToRelayMock).toHaveBeenCalledWith(
      'wss://relay.test',
      { id: 'event123' },
      PUBKEY,
      PRIVKEY,
      expect.any(Function),
    );
  });
});
