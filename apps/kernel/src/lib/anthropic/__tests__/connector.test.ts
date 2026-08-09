import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  loadAnthropicCredentials,
  requireGrantAndKey,
  anthropicKeySealed,
  anthropicKeyPending,
  vaultField,
  revokeApiKey,
  ANTHROPIC_CONNECTOR_DID,
} from '../connector';

const OWNER = 'did:imajin:veteze';
const API_KEY = 'sk-ant-REDACTED';
const BASE_URL = 'https://my-gateway.example/anthropic';
const MODEL_ID = 'claude-opus-4-20250514';

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sealMock.mockResolvedValue(undefined);
  sealV1Mock.mockResolvedValue(undefined);
  loadMock.mockResolvedValue(undefined);
  existsMock.mockResolvedValue(false);
  statusMock.mockResolvedValue('absent');
  revokeVaultGrantsMock.mockResolvedValue(0);
  channelLinksRevokeMock.mockResolvedValue([]);
});

// ── Identity + isolation ──────────────────────────────────────────────────────

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`anthropic-api-key:${OWNER}`);
  });

  it('gives different DIDs different fields, so cross-DID reads are structural', () => {
    expect(vaultField('did:imajin:alice')).toBe('anthropic-api-key:did:imajin:alice');
    expect(vaultField('did:imajin:bob')).toBe('anthropic-api-key:did:imajin:bob');
  });
});

describe('ANTHROPIC_CONNECTOR_DID', () => {
  it('is stable', () => {
    expect(ANTHROPIC_CONNECTOR_DID).toBe('did:imajin:anthropic-connector');
  });
});

// ── Grant resolution ──────────────────────────────────────────────────────────

describe('resolveActiveGrant', () => {
  it('is true when an active row includes the required scope', async () => {
    grant(['anthropic:infer']);
    expect(await resolveActiveGrant(OWNER, 'anthropic:infer')).toBe(true);
  });

  it('is false when an active row lacks the required scope', async () => {
    grant(['other:scope']);
    expect(await resolveActiveGrant(OWNER, 'anthropic:infer')).toBe(false);
  });

  it('is false when there are no rows at all', async () => {
    noGrant();
    expect(await resolveActiveGrant(OWNER, 'anthropic:infer')).toBe(false);
  });
});

// ── Sealing ───────────────────────────────────────────────────────────────────

describe('sealApiKey', () => {
  it('seals the API key under the per-DID vault field, with delegation-grant custody', async () => {
    await sealApiKey(OWNER, API_KEY);
    const [field, plaintext] = sealMock.mock.calls[0] as [string, string];
    expect(field).toBe(vaultField(OWNER));
    expect(plaintext).toBe(API_KEY);
  });

  /**
   * The endpoint and the model name are neither secret nor authority-bearing, so
   * they are node-sealed (v1) rather than delegation-grant (#1637). Under Tier 1
   * a v2 write is unreadable until the owner agent approves it, which would mean
   * a model override silently not applying.
   */
  it('seals the optional baseUrl node-sealed, under its own field', async () => {
    await sealApiKey(OWNER, API_KEY, BASE_URL);
    expect(sealV1Mock.mock.calls[0]).toEqual([`anthropic-base-url:${OWNER}`, BASE_URL]);
    expect(sealMock).toHaveBeenCalledOnce();
  });

  it('seals the optional modelId node-sealed — the owner choosing their Claude model', async () => {
    await sealApiKey(OWNER, API_KEY, undefined, MODEL_ID);
    expect(sealV1Mock.mock.calls[0]).toEqual([`anthropic-model-id:${OWNER}`, MODEL_ID]);
    expect(sealMock).toHaveBeenCalledOnce();
  });

  it('writes only the key when the optional fields are omitted', async () => {
    await sealApiKey(OWNER, API_KEY);
    expect(sealMock).toHaveBeenCalledOnce();
    expect(sealV1Mock).not.toHaveBeenCalled();
  });
});

// ── Credential resolution ─────────────────────────────────────────────────────

describe('loadAnthropicCredentials', () => {
  it('returns undefined without an active grant and never touches the vault', async () => {
    noGrant();

    expect(await loadAnthropicCredentials(OWNER)).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('returns undefined when granted but no key is sealed', async () => {
    grant(['anthropic:infer']);
    loadMock.mockResolvedValue(undefined);

    expect(await loadAnthropicCredentials(OWNER)).toBeUndefined();
  });

  it('returns the key alone when no overrides are sealed', async () => {
    grant(['anthropic:infer']);
    loadMock
      .mockResolvedValueOnce(API_KEY)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    expect(await loadAnthropicCredentials(OWNER)).toEqual({ apiKey: API_KEY });
  });

  it('returns the sealed baseUrl and modelId when present', async () => {
    grant(['anthropic:infer']);
    loadMock
      .mockResolvedValueOnce(API_KEY)
      .mockResolvedValueOnce(BASE_URL)
      .mockResolvedValueOnce(MODEL_ID);

    expect(await loadAnthropicCredentials(OWNER)).toEqual({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      modelId: MODEL_ID,
    });
  });

  it('returns undefined when the key is sealed but awaiting owner approval (#1637)', async () => {
    grant(['anthropic:infer']);
    loadMock.mockRejectedValueOnce(
      new VaultDelegationError('awaiting grant', {
        field: vaultField(OWNER),
        nodeDid: 'did:imajin:node',
      }),
    );

    await expect(loadAnthropicCredentials(OWNER)).resolves.toBeUndefined();
  });
});

// ── Fail-closed gate ──────────────────────────────────────────────────────────

describe('requireGrantAndKey', () => {
  it('throws anthropic_no_grant when no grant is active', async () => {
    noGrant();
    await expect(requireGrantAndKey(OWNER, 'anthropic:infer')).rejects.toThrow(/anthropic_no_grant/);
  });

  it('throws anthropic_no_key when granted but nothing is sealed', async () => {
    grant(['anthropic:infer']);
    loadMock.mockResolvedValue(undefined);
    await expect(requireGrantAndKey(OWNER, 'anthropic:infer')).rejects.toThrow(/anthropic_no_key/);
  });

  it('distinguishes a pending owner grant from a missing key (#1603 shape)', async () => {
    grant(['anthropic:infer']);
    loadMock.mockRejectedValueOnce(
      new VaultDelegationError('awaiting grant', {
        field: vaultField(OWNER),
        nodeDid: 'did:imajin:node',
      }),
    );

    await expect(requireGrantAndKey(OWNER, 'anthropic:infer'))
      .rejects.toThrow(/anthropic_credential_pending/);
  });

  it('returns the key when both gates pass', async () => {
    grant(['anthropic:infer']);
    loadMock.mockResolvedValueOnce(API_KEY);

    expect(await requireGrantAndKey(OWNER, 'anthropic:infer')).toBe(API_KEY);
  });

  it('never names the key in a failure message', async () => {
    noGrant();
    const err = await requireGrantAndKey(OWNER, 'anthropic:infer').catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(API_KEY);
  });
});

// ── Status helpers ────────────────────────────────────────────────────────────

// #1724: `anthropicKeySealed` used to delegate to `vaultFieldExists`, which
// only checks that the vault entry exists — not whether an active grant
// covers it. `revokeApiKey` (disconnect) leaves the entry in place and only
// revokes the grant, so that reported a disconnected key as sealed forever.
// It now delegates to `vaultFieldStatus`, which filters `WHERE status = 'active'`.
describe('status helpers', () => {
  it('reports a sealed key via the per-DID field', async () => {
    statusMock.mockResolvedValueOnce('ready');
    expect(await anthropicKeySealed(OWNER)).toBe(true);
    expect(statusMock).toHaveBeenCalledWith(vaultField(OWNER));
  });

  it('reports unsealed once the grant is revoked, even though the vault entry still exists', async () => {
    // A revoked grant reports 'pending-grant' — no active grant covers the
    // entry — not 'ready'. This is the exact disconnect state from #1724.
    statusMock.mockResolvedValueOnce('pending-grant');
    expect(await anthropicKeySealed(OWNER)).toBe(false);
  });

  it('reports pending-grant separately from sealed', async () => {
    statusMock.mockResolvedValueOnce('pending-grant');
    expect(await anthropicKeyPending(OWNER)).toBe(true);
  });

  it('is not pending when the field is simply absent', async () => {
    statusMock.mockResolvedValueOnce('absent');
    expect(await anthropicKeyPending(OWNER)).toBe(false);
  });
});

// ── revokeApiKey (#1720) ──────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  it('delegates to revokeVaultDelegationGrantsForConnector with the connector id and owner DID', async () => {
    revokeVaultGrantsMock.mockResolvedValue(1);
    await revokeApiKey(OWNER);
    expect(revokeVaultGrantsMock).toHaveBeenCalledWith('anthropic', OWNER);
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
