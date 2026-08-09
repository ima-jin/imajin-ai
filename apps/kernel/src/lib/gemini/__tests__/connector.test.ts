import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealMock, sealV1Mock, loadMock, existsMock, statusMock, whereMock, revokeVaultGrantsMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  sealV1Mock: vi.fn(),
  loadMock: vi.fn(),
  existsMock: vi.fn(),
  statusMock: vi.fn(),
  whereMock: vi.fn(),
  revokeVaultGrantsMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndStore: sealV1Mock,
  sealAndStoreV2: sealMock,
  loadAndUnseal: loadMock,
  vaultFieldExists: existsMock,
  vaultFieldStatus: statusMock,
  revokeVaultDelegationGrantsForConnector: revokeVaultGrantsMock,
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { VaultDelegationError } from '@/src/lib/vault/errors';
import {
  resolveActiveGrant,
  sealApiKey,
  loadGeminiCredentials,
  requireGrantAndKey,
  geminiKeySealed,
  geminiKeyPending,
  vaultField,
  revokeApiKey,
  GEMINI_CONNECTOR_DID,
} from '../connector';

const OWNER = 'did:imajin:farmer';
const API_KEY = 'AIzaSy-REDACTED';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL_ID = 'gemini-2.0-flash';

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  sealV1Mock.mockReset();
  sealV1Mock.mockResolvedValue(undefined);
  loadMock.mockReset();
  loadMock.mockResolvedValue(undefined);
  existsMock.mockReset();
  existsMock.mockResolvedValue(false);
  statusMock.mockReset();
  statusMock.mockResolvedValue('absent');
  whereMock.mockReset();
  revokeVaultGrantsMock.mockReset();
  revokeVaultGrantsMock.mockResolvedValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── vaultField ────────────────────────────────────────────────────────────────

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`gemini-api-key:${OWNER}`);
  });
});

// ── Cross-DID isolation ───────────────────────────────────────────────────────

describe('cross-DID isolation', () => {
  it('different DIDs have different vault fields', () => {
    const fieldA = vaultField('did:imajin:alice');
    const fieldB = vaultField('did:imajin:bob');
    expect(fieldA).not.toBe(fieldB);
    expect(fieldA).toBe('gemini-api-key:did:imajin:alice');
    expect(fieldB).toBe('gemini-api-key:did:imajin:bob');
  });
});

// ── GEMINI_CONNECTOR_DID ──────────────────────────────────────────────────────

describe('GEMINI_CONNECTOR_DID', () => {
  it('is stable', () => {
    expect(GEMINI_CONNECTOR_DID).toBe('did:imajin:gemini-connector');
  });
});

// ── resolveActiveGrant ────────────────────────────────────────────────────────

describe('resolveActiveGrant', () => {
  it('is true when an active row includes the required scope', async () => {
    grant(['gemini:infer']);
    expect(await resolveActiveGrant(OWNER, 'gemini:infer')).toBe(true);
  });

  it('is false when no active row includes the required scope', async () => {
    grant(['other:scope']);
    expect(await resolveActiveGrant(OWNER, 'gemini:infer')).toBe(false);
  });

  it('is false when there are no rows at all', async () => {
    noGrant();
    expect(await resolveActiveGrant(OWNER, 'gemini:infer')).toBe(false);
  });
});

// ── sealApiKey ────────────────────────────────────────────────────────────────

describe('sealApiKey', () => {
  it('seals the API key under the per-DID vault field with delegation-grant custody', async () => {
    await sealApiKey(OWNER, API_KEY);
    const [field, plaintext] = sealMock.mock.calls[0] as [string, string];
    expect(field).toBe(vaultField(OWNER));
    expect(plaintext).toBe(API_KEY);
  });

  it('seals baseUrl node-sealed (v1), not delegation-grant (#1637)', async () => {
    await sealApiKey(OWNER, API_KEY, BASE_URL);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock.mock.calls[0]).toEqual([`gemini-base-url:${OWNER}`, BASE_URL]);
  });

  it('seals modelId node-sealed (v1), not delegation-grant (#1637)', async () => {
    await sealApiKey(OWNER, API_KEY, undefined, MODEL_ID);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock.mock.calls[0]).toEqual([`gemini-model-id:${OWNER}`, MODEL_ID]);
  });

  it('seals all three, one under v2 custody and two under v1', async () => {
    await sealApiKey(OWNER, API_KEY, BASE_URL, MODEL_ID);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).toHaveBeenCalledTimes(2);
  });

  it('does not seal baseUrl or modelId when omitted', async () => {
    await sealApiKey(OWNER, API_KEY);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).not.toHaveBeenCalled();
  });
});

// ── loadGeminiCredentials ────────────────────────────────────────────────────

describe('loadGeminiCredentials', () => {
  it('returns undefined when there is no active grant', async () => {
    noGrant();
    const result = await loadGeminiCredentials(OWNER);
    expect(result).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('returns undefined when there is a grant but no sealed key', async () => {
    grant(['gemini:infer']);
    loadMock.mockResolvedValue(undefined); // no key sealed
    const result = await loadGeminiCredentials(OWNER);
    expect(result).toBeUndefined();
  });

  it('returns credentials with apiKey when grant and key are present', async () => {
    grant(['gemini:infer']);
    // loadAndUnseal called three times: apiKey, baseUrl, modelId
    loadMock.mockResolvedValueOnce(API_KEY)      // apiKey field
      .mockResolvedValueOnce(undefined)           // baseUrl field (not set)
      .mockResolvedValueOnce(undefined);          // modelId field (not set)

    const result = await loadGeminiCredentials(OWNER);
    expect(result).not.toBeUndefined();
    expect(result?.apiKey).toBe(API_KEY);
    expect(result?.baseUrl).toBeUndefined();
    expect(result?.modelId).toBeUndefined();
  });

  it('returns credentials with apiKey + baseUrl + modelId when all are sealed', async () => {
    grant(['gemini:infer']);
    loadMock.mockResolvedValueOnce(API_KEY)
      .mockResolvedValueOnce(BASE_URL)
      .mockResolvedValueOnce(MODEL_ID);

    const result = await loadGeminiCredentials(OWNER);
    expect(result?.apiKey).toBe(API_KEY);
    expect(result?.baseUrl).toBe(BASE_URL);
    expect(result?.modelId).toBe(MODEL_ID);
  });

  /**
   * #1637: this used to throw, which took the whole brain walk down with it — so
   * a Gemini key awaiting Tier 1 approval meant a healthy Anthropic key was never
   * tried. `undefined` is the documented answer for "no usable connection".
   */
  it('returns undefined when the key is sealed but awaiting owner approval', async () => {
    grant(['gemini:infer']);
    loadMock.mockRejectedValueOnce(
      new VaultDelegationError('no active grant', {
        field: vaultField(OWNER),
        nodeDid: 'did:imajin:node',
      }),
    );

    await expect(loadGeminiCredentials(OWNER)).resolves.toBeUndefined();
  });

  it('still propagates a non-delegation vault failure', async () => {
    grant(['gemini:infer']);
    loadMock.mockRejectedValueOnce(new Error('vault integrity failure'));

    await expect(loadGeminiCredentials(OWNER)).rejects.toThrow('vault integrity failure');
  });

  it('degrades an unreadable baseUrl/modelId to "no override" instead of failing', async () => {
    grant(['gemini:infer']);
    loadMock
      .mockResolvedValueOnce(API_KEY)
      .mockRejectedValueOnce(
        // A pre-#1637 v2 config entry whose grant never arrived.
        new VaultDelegationError('no active grant', {
          field: `gemini-base-url:${OWNER}`,
          nodeDid: 'did:imajin:node',
        }),
      )
      .mockRejectedValueOnce(new Error('corrupt entry'));

    await expect(loadGeminiCredentials(OWNER)).resolves.toEqual({ apiKey: API_KEY });
  });
});

// ── requireGrantAndKey ───────────────────────────────────────────────────────

describe('requireGrantAndKey (fail-closed gate)', () => {
  it('throws gemini_no_grant when there is no active grant', async () => {
    noGrant();
    await expect(requireGrantAndKey(OWNER, 'gemini:infer')).rejects.toThrow(/gemini_no_grant/);
  });

  it('throws gemini_no_key when grant exists but no key is sealed', async () => {
    grant(['gemini:infer']);
    loadMock.mockResolvedValue(undefined);
    await expect(requireGrantAndKey(OWNER, 'gemini:infer')).rejects.toThrow(/gemini_no_key/);
  });

  it('returns the key when both grant and key are present', async () => {
    grant(['gemini:infer']);
    loadMock.mockResolvedValue(API_KEY);
    const key = await requireGrantAndKey(OWNER, 'gemini:infer');
    expect(key).toBe(API_KEY);
  });

  it('throws gemini_credential_pending when the key is sealed but no grant has arrived (#1521)', async () => {
    grant(['gemini:infer']);
    loadMock.mockRejectedValue(new VaultDelegationError('no active grant', { field: vaultField(OWNER), nodeDid: 'did:imajin:node' }));
    await expect(requireGrantAndKey(OWNER, 'gemini:infer')).rejects.toThrow(/gemini_credential_pending/);
  });
});

// ── geminiKeySealed ───────────────────────────────────────────────────────────

describe('geminiKeySealed', () => {
  it('delegates to vaultFieldExists with the per-DID field', async () => {
    existsMock.mockResolvedValue(true);
    expect(await geminiKeySealed(OWNER)).toBe(true);
    expect(existsMock).toHaveBeenCalledWith(vaultField(OWNER));
  });

  it('returns false when no key is sealed', async () => {
    existsMock.mockResolvedValue(false);
    expect(await geminiKeySealed(OWNER)).toBe(false);
  });
});

describe('geminiKeyPending (#1521)', () => {
  it('is true when the field status is pending-grant', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await geminiKeyPending(OWNER)).toBe(true);
    expect(statusMock).toHaveBeenCalledWith(vaultField(OWNER));
  });

  it('is false when the field is ready, absent, or unverifiable', async () => {
    for (const status of ['ready', 'absent', 'unverifiable']) {
      statusMock.mockResolvedValue(status);
      expect(await geminiKeyPending(OWNER)).toBe(false);
    }
  });
});

// ── revokeApiKey (#1720) ──────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  it('delegates to revokeVaultDelegationGrantsForConnector with the connector id and owner DID', async () => {
    revokeVaultGrantsMock.mockResolvedValue(1);
    await revokeApiKey(OWNER);
    expect(revokeVaultGrantsMock).toHaveBeenCalledWith('gemini', OWNER);
  });

  it('returns true when at least one grant was revoked', async () => {
    revokeVaultGrantsMock.mockResolvedValue(1);
    expect(await revokeApiKey(OWNER)).toBe(true);
  });

  it('returns false when no active grant existed', async () => {
    revokeVaultGrantsMock.mockResolvedValue(0);
    expect(await revokeApiKey(OWNER)).toBe(false);
  });
});
