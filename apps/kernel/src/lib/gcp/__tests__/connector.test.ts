import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  sealMock, sealV1Mock, loadMock, existsMock, statusMock, whereMock,
  revokeVaultGrantsMock, channelLinksRevokeMock,
} = vi.hoisted(() => ({
  sealMock: vi.fn(),
  sealV1Mock: vi.fn(),
  loadMock: vi.fn(),
  existsMock: vi.fn(),
  statusMock: vi.fn(),
  whereMock: vi.fn(),
  revokeVaultGrantsMock: vi.fn(),
  // #1733: `revokeApiKey` also sweeps active channel_links rows — backs the
  // `.returning(...)` call on `db.update(channelLinks)...`.
  channelLinksRevokeMock: vi.fn(),
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
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: channelLinksRevokeMock }) }) }),
  },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes', id: 'id' },
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { VaultDelegationError } from '@/src/lib/vault/errors';
import {
  resolveActiveGrant,
  sealApiKey,
  loadGcpCredentials,
  requireGrantAndKey,
  gcpKeySealed,
  gcpKeyPending,
  vaultField,
  revokeApiKey,
  GCP_CONNECTOR_DID,
  GCP_VERTEX_SCOPE,
} from '../connector';

const OWNER = 'did:imajin:farmer';
/** A service-account key JSON, sealed verbatim — the kernel never parses it. */
const API_KEY = '{"type":"service_account","private_key":"REDACTED"}';
const BASE_URL = 'https://us-central1-aiplatform.googleapis.com/v1';
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
  channelLinksRevokeMock.mockReset();
  channelLinksRevokeMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── vaultField ────────────────────────────────────────────────────────────────

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`gcp-api-key:${OWNER}`);
  });
});

// ── Cross-DID isolation ───────────────────────────────────────────────────────

describe('cross-DID isolation', () => {
  it('different DIDs have different vault fields', () => {
    const fieldA = vaultField('did:imajin:alice');
    const fieldB = vaultField('did:imajin:bob');
    expect(fieldA).not.toBe(fieldB);
    expect(fieldA).toBe('gcp-api-key:did:imajin:alice');
    expect(fieldB).toBe('gcp-api-key:did:imajin:bob');
  });

  /**
   * The prefix is what keeps a GCP key out of the Gemini connector's reach and
   * vice versa. Both providers are Google, so the two would otherwise be easy to
   * conflate — and a shared field would let one connector's grant unseal the
   * other's credential.
   */
  it('does not collide with the Gemini connector field for the same DID', () => {
    expect(vaultField(OWNER)).not.toBe(`gemini-api-key:${OWNER}`);
  });
});

// ── Identity ──────────────────────────────────────────────────────────────────

describe('GCP_CONNECTOR_DID', () => {
  it('is stable', () => {
    expect(GCP_CONNECTOR_DID).toBe('did:imajin:gcp-connector');
  });
});

describe('GCP_VERTEX_SCOPE', () => {
  it('is the scope credential loading gates on', () => {
    expect(GCP_VERTEX_SCOPE).toBe('gcp:vertex:invoke');
  });
});

// ── resolveActiveGrant ────────────────────────────────────────────────────────

describe('resolveActiveGrant', () => {
  it('is true when an active row includes the required scope', async () => {
    grant(['gcp:vertex:invoke']);
    expect(await resolveActiveGrant(OWNER, 'gcp:vertex:invoke')).toBe(true);
  });

  it('is false when no active row includes the required scope', async () => {
    grant(['other:scope']);
    expect(await resolveActiveGrant(OWNER, 'gcp:vertex:invoke')).toBe(false);
  });

  it('is false when there are no rows at all', async () => {
    noGrant();
    expect(await resolveActiveGrant(OWNER, 'gcp:vertex:invoke')).toBe(false);
  });

  /**
   * The three Stage 1 scopes are granted independently, so holding one must not
   * imply the others: a DID that granted read-only project metadata has not
   * agreed to let its key spend Vertex quota.
   */
  it('does not let one Stage 1 scope stand in for another', async () => {
    grant(['gcp:project:read']);
    expect(await resolveActiveGrant(OWNER, 'gcp:vertex:invoke')).toBe(false);
    expect(await resolveActiveGrant(OWNER, 'gcp:iam:read')).toBe(false);
    expect(await resolveActiveGrant(OWNER, 'gcp:project:read')).toBe(true);
  });
});

// ── sealApiKey ────────────────────────────────────────────────────────────────

describe('sealApiKey', () => {
  it('seals the service-account key under the per-DID vault field with delegation-grant custody', async () => {
    await sealApiKey(OWNER, API_KEY);
    const [field, plaintext] = sealMock.mock.calls[0] as [string, string];
    expect(field).toBe(vaultField(OWNER));
    expect(plaintext).toBe(API_KEY);
  });

  it('seals baseUrl node-sealed (v1), not delegation-grant (#1637)', async () => {
    await sealApiKey(OWNER, API_KEY, BASE_URL);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock.mock.calls[0]).toEqual([`gcp-base-url:${OWNER}`, BASE_URL]);
  });

  it('seals modelId node-sealed (v1), not delegation-grant (#1637)', async () => {
    await sealApiKey(OWNER, API_KEY, undefined, MODEL_ID);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock.mock.calls[0]).toEqual([`gcp-model-id:${OWNER}`, MODEL_ID]);
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

// ── loadGcpCredentials ────────────────────────────────────────────────────────

describe('loadGcpCredentials', () => {
  it('returns undefined when there is no active grant', async () => {
    noGrant();
    const result = await loadGcpCredentials(OWNER);
    expect(result).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('returns undefined when there is a grant but no sealed key', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockResolvedValue(undefined); // no key sealed
    const result = await loadGcpCredentials(OWNER);
    expect(result).toBeUndefined();
  });

  it('returns credentials with apiKey when grant and key are present', async () => {
    grant(['gcp:vertex:invoke']);
    // loadAndUnseal called three times: apiKey, baseUrl, modelId
    loadMock.mockResolvedValueOnce(API_KEY)      // apiKey field
      .mockResolvedValueOnce(undefined)           // baseUrl field (not set)
      .mockResolvedValueOnce(undefined);          // modelId field (not set)

    const result = await loadGcpCredentials(OWNER);
    expect(result).not.toBeUndefined();
    expect(result?.apiKey).toBe(API_KEY);
    expect(result?.baseUrl).toBeUndefined();
    expect(result?.modelId).toBeUndefined();
  });

  it('returns credentials with apiKey + baseUrl + modelId when all are sealed', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockResolvedValueOnce(API_KEY)
      .mockResolvedValueOnce(BASE_URL)
      .mockResolvedValueOnce(MODEL_ID);

    const result = await loadGcpCredentials(OWNER);
    expect(result?.apiKey).toBe(API_KEY);
    expect(result?.baseUrl).toBe(BASE_URL);
    expect(result?.modelId).toBe(MODEL_ID);
  });

  /**
   * #1637: returning `undefined` rather than throwing is what lets a caller move
   * on. A key awaiting Tier 1 approval is a legitimate, expected state, not a
   * failure to propagate.
   */
  it('returns undefined when the key is sealed but awaiting owner approval', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockRejectedValueOnce(
      new VaultDelegationError('no active grant', {
        field: vaultField(OWNER),
        nodeDid: 'did:imajin:node',
      }),
    );

    await expect(loadGcpCredentials(OWNER)).resolves.toBeUndefined();
  });

  it('still propagates a non-delegation vault failure', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockRejectedValueOnce(new Error('vault integrity failure'));

    await expect(loadGcpCredentials(OWNER)).rejects.toThrow('vault integrity failure');
  });

  it('degrades an unreadable baseUrl/modelId to "no override" instead of failing', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock
      .mockResolvedValueOnce(API_KEY)
      .mockRejectedValueOnce(
        // A pre-#1637 v2 config entry whose grant never arrived.
        new VaultDelegationError('no active grant', {
          field: `gcp-base-url:${OWNER}`,
          nodeDid: 'did:imajin:node',
        }),
      )
      .mockRejectedValueOnce(new Error('corrupt entry'));

    await expect(loadGcpCredentials(OWNER)).resolves.toEqual({ apiKey: API_KEY });
  });
});

// ── requireGrantAndKey ────────────────────────────────────────────────────────

describe('requireGrantAndKey (fail-closed gate)', () => {
  it('throws gcp_no_grant when there is no active grant', async () => {
    noGrant();
    await expect(requireGrantAndKey(OWNER, 'gcp:vertex:invoke')).rejects.toThrow(/gcp_no_grant/);
  });

  it('throws gcp_no_key when grant exists but no key is sealed', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockResolvedValue(undefined);
    await expect(requireGrantAndKey(OWNER, 'gcp:vertex:invoke')).rejects.toThrow(/gcp_no_key/);
  });

  it('returns the key when both grant and key are present', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockResolvedValue(API_KEY);
    const key = await requireGrantAndKey(OWNER, 'gcp:vertex:invoke');
    expect(key).toBe(API_KEY);
  });

  it('throws gcp_credential_pending when the key is sealed but no grant has arrived (#1521)', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockRejectedValue(new VaultDelegationError('no active grant', { field: vaultField(OWNER), nodeDid: 'did:imajin:node' }));
    await expect(requireGrantAndKey(OWNER, 'gcp:vertex:invoke')).rejects.toThrow(/gcp_credential_pending/);
  });

  /**
   * Stage 2 will call this per operation with the scope that operation needs, so
   * the gate has to be genuinely per-scope rather than "any GCP grant will do".
   */
  it('gates each Stage 1 scope separately', async () => {
    grant(['gcp:vertex:invoke']);
    loadMock.mockResolvedValue(API_KEY);
    await expect(requireGrantAndKey(OWNER, 'gcp:iam:read')).rejects.toThrow(/gcp_no_grant/);
  });
});

// ── gcpKeySealed / gcpKeyPending ──────────────────────────────────────────────

// #1724: `gcpKeySealed` used to delegate to `vaultFieldExists`, which only
// checks that the vault entry exists — not whether an active grant covers it.
// `revokeApiKey` (disconnect) leaves the entry in place and only revokes the
// grant, so that reported a disconnected key as sealed forever. It now
// delegates to `vaultFieldStatus`, which filters `WHERE status = 'active'`.
describe('gcpKeySealed', () => {
  it('delegates to vaultFieldStatus with the per-DID field', async () => {
    statusMock.mockResolvedValue('ready');
    expect(await gcpKeySealed(OWNER)).toBe(true);
    expect(statusMock).toHaveBeenCalledWith(vaultField(OWNER));
  });

  it('returns false when no key is sealed', async () => {
    statusMock.mockResolvedValue('absent');
    expect(await gcpKeySealed(OWNER)).toBe(false);
  });

  it('returns false once the grant is revoked, even though the vault entry still exists', async () => {
    // A revoked grant reports 'pending-grant' (no active grant covers the
    // entry), not 'ready' — this is the exact disconnect state from #1724.
    statusMock.mockResolvedValue('pending-grant');
    expect(await gcpKeySealed(OWNER)).toBe(false);
  });
});

describe('gcpKeyPending (#1521)', () => {
  it('is true when the field status is pending-grant', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await gcpKeyPending(OWNER)).toBe(true);
    expect(statusMock).toHaveBeenCalledWith(vaultField(OWNER));
  });

  it('is false when the field is ready, absent, or unverifiable', async () => {
    for (const status of ['ready', 'absent', 'unverifiable']) {
      statusMock.mockResolvedValue(status);
      expect(await gcpKeyPending(OWNER)).toBe(false);
    }
  });
});

// ── revokeApiKey (#1720) ──────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  it('delegates to revokeVaultDelegationGrantsForConnector with the connector id and owner DID', async () => {
    revokeVaultGrantsMock.mockResolvedValue(1);
    await revokeApiKey(OWNER);
    expect(revokeVaultGrantsMock).toHaveBeenCalledWith('gcp', OWNER);
  });

  it('returns true when at least one grant was revoked', async () => {
    revokeVaultGrantsMock.mockResolvedValue(1);
    expect(await revokeApiKey(OWNER)).toBe(true);
  });

  it('returns false when no active grant existed', async () => {
    revokeVaultGrantsMock.mockResolvedValue(0);
    expect(await revokeApiKey(OWNER)).toBe(false);
  });

  // #1733: revoking only the vault grant left every previously granted
  // channel_links scope reporting active forever. `revokeApiKey` now also
  // sweeps active channel_links rows for this connector + DID.
  it('also revokes active channel_links rows, even with nothing left in the vault to revoke', async () => {
    revokeVaultGrantsMock.mockResolvedValue(0);
    channelLinksRevokeMock.mockResolvedValue([{ id: 'clink_1' }]);
    expect(await revokeApiKey(OWNER)).toBe(true);
  });

  it('returns false when neither the vault grant nor any channel_links row was active', async () => {
    revokeVaultGrantsMock.mockResolvedValue(0);
    channelLinksRevokeMock.mockResolvedValue([]);
    expect(await revokeApiKey(OWNER)).toBe(false);
  });
});
