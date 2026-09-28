/**
 * Unit tests for `resolveSigningKeyForGrant` and its HTTP status/error
 * mappers (#2411) — the shared core behind both `POST /api/apps/claim` and
 * `POST /api/apps/signing-key/fetch`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchGrantSecretMock, getMintedKeyByDidMock, publishMock } = vi.hoisted(() => ({
  fetchGrantSecretMock: vi.fn(),
  getMintedKeyByDidMock: vi.fn(),
  publishMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('@/src/lib/vault', () => ({ fetchGrantSecret: fetchGrantSecretMock }));
vi.mock('@/src/lib/vault/key-cards', () => ({ getMintedKeyByDid: getMintedKeyByDidMock }));
vi.mock('@/src/lib/apps/signing-key-claims', () => ({ APP_SIGNING_KEY_PURPOSE: 'app-signing-key' }));

import {
  resolveSigningKeyForGrant,
  statusForSigningKeyFetchOutcome,
  errorForSigningKeyFetchOutcome,
  emitSigningKeyFetchedEvent,
} from '../signing-key-fetch';

const APP_DID = 'did:imajin:app-under-test';
const GRANT_ID = 'vdg_app_self_1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSigningKeyForGrant', () => {
  it('returns the plaintext key + public key on success', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'private-hex', grant: { purpose: 'app-signing-key' } });
    getMintedKeyByDidMock.mockResolvedValue({ publicKey: 'public-hex' });

    const outcome = await resolveSigningKeyForGrant({ grantId: GRANT_ID, appDid: APP_DID });

    expect(outcome).toEqual({ status: 'ok', appDid: APP_DID, privateKey: 'private-hex', publicKey: 'public-hex' });
  });

  it('returns publicKey: null when no minted-key row is found', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'private-hex', grant: { purpose: 'app-signing-key' } });
    getMintedKeyByDidMock.mockResolvedValue(undefined);

    const outcome = await resolveSigningKeyForGrant({ grantId: GRANT_ID, appDid: APP_DID });

    expect(outcome).toMatchObject({ status: 'ok', publicKey: null });
  });

  it.each(['not_found', 'not_grantee', 'inactive', 'expired', 'consumed'] as const)('passes through a non-ok fetchGrantSecret outcome (%s)', async (status) => {
    fetchGrantSecretMock.mockResolvedValue({ status });

    const outcome = await resolveSigningKeyForGrant({ grantId: GRANT_ID, appDid: APP_DID });

    expect(outcome).toEqual({ status });
    expect(getMintedKeyByDidMock).not.toHaveBeenCalled();
  });

  it('refuses with wrong_purpose when the grant is not purpose-bound to app-signing-key', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'private-hex', grant: { purpose: 'some-other-purpose' } });

    const outcome = await resolveSigningKeyForGrant({ grantId: GRANT_ID, appDid: APP_DID });

    expect(outcome).toEqual({ status: 'wrong_purpose' });
  });
});

describe('statusForSigningKeyFetchOutcome / errorForSigningKeyFetchOutcome', () => {
  it.each([
    ['not_found', 404],
    ['not_grantee', 404],
    ['consumed', 410],
    ['wrong_purpose', 500],
    ['inactive', 403],
    ['expired', 403],
  ] as const)('maps %s to HTTP %i', (status, expectedStatus) => {
    expect(statusForSigningKeyFetchOutcome(status)).toBe(expectedStatus);
  });

  it('never includes secret material in any error message', () => {
    for (const status of ['not_found', 'not_grantee', 'consumed', 'wrong_purpose', 'inactive', 'expired'] as const) {
      expect(errorForSigningKeyFetchOutcome(status)).not.toContain('private-hex');
    }
  });
});

describe('emitSigningKeyFetchedEvent', () => {
  it('publishes apps.signing-key.fetched tagged with the given via value', () => {
    emitSigningKeyFetchedEvent({ nodeDid: 'did:imajin:node', slug: 'dykil', appDid: APP_DID, grantId: GRANT_ID, outcome: 'ok', via: 'bootstrap-key' });

    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.fetched', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', appDid: APP_DID, grantId: GRANT_ID, outcome: 'ok', via: 'bootstrap-key' }),
    }));
  });
});
