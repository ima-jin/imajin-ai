/**
 * Tests for the operator-approvals contract module (#2059, generalized to
 * an open source/kind vocabulary by #2152): payload validation (legacy
 * bare-kind normalization, open-vocabulary source/kind, the bounded
 * `detail` object, the hash-covers-detail invariant, and the
 * secret-redaction boundary, acceptance (e)), plus the load-bearing
 * `isOperatorIdentity` auth invariant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetNodeSelfInfo } = vi.hoisted(() => ({ mockGetNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: mockGetNodeSelfInfo }));

import {
  validateApprovalRequestedPayload,
  computeApprovalContentHash,
  looksLikeSecretValue,
  isOperatorIdentity,
  getOperatorDid,
} from '../operator-approvals';
import {
  OPERATOR_DID,
  operatorIdentity,
  otherHumanIdentity,
  agentActingForOperatorIdentity,
} from './operator-approvals-test-helpers';

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: 'opap_1',
    kind: 'restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: ['gateway.plugins.openclaw.version'],
    ...overrides,
  };
}

/** A well-formed open-vocabulary payload (explicit source, namespaced kind, detail, valid contentHash). */
function openVocabPayload(overrides: Record<string, unknown> = {}) {
  const base = {
    proposalId: 'opap_sw_1',
    source: 'skill-workshop',
    kind: 'skill-workshop:update',
    summary: 'Update the weather-lookup skill.',
    keysTouched: [] as string[],
    detail: { skillName: 'weather-lookup', kind: 'update', scan: 'clean' },
  };
  const merged = { ...base, ...overrides };
  const contentHash = 'contentHash' in overrides
    ? overrides.contentHash
    : computeApprovalContentHash({
      proposalId: merged.proposalId,
      source: merged.source,
      kind: merged.kind,
      summary: merged.summary,
      keysTouched: merged.keysTouched,
      detail: merged.detail,
    });
  return { ...merged, contentHash };
}

describe('validateApprovalRequestedPayload — legacy bare kinds (#2152 backward compat)', () => {
  it('accepts a well-formed legacy payload and normalizes onto system-agent:*', () => {
    expect(validateApprovalRequestedPayload(validPayload())).toEqual({
      ok: true,
      source: 'system-agent',
      kind: 'system-agent:restart',
      detail: null,
      contentHash: null,
    });
  });

  it.each(['restart', 'config-mutation', 'other'])('normalizes legacy bare kind %s onto system-agent:%s', (kind) => {
    const result = validateApprovalRequestedPayload(validPayload({ kind }));
    expect(result).toEqual(expect.objectContaining({ ok: true, source: 'system-agent', kind: `system-agent:${kind}` }));
  });

  it('accepts an empty keysTouched array', () => {
    expect(validateApprovalRequestedPayload(validPayload({ keysTouched: [] })).ok).toBe(true);
  });

  it('does not require contentHash for a legacy bare-kind request', () => {
    const result = validateApprovalRequestedPayload(validPayload());
    expect(result.ok).toBe(true);
    expect(result.contentHash).toBeNull();
  });

  it.each([
    ['missing proposalId', { proposalId: undefined }],
    ['empty proposalId', { proposalId: '' }],
    ['missing kind', { kind: undefined }],
    ['invalid kind', { kind: 'reboot-everything' }],
    ['missing summary', { summary: undefined }],
    ['empty summary', { summary: '' }],
  ])('rejects %s', (_label, overrides) => {
    const result = validateApprovalRequestedPayload(validPayload(overrides));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects keysTouched that is not an array', () => {
    const result = validateApprovalRequestedPayload(validPayload({ keysTouched: 'gateway.token' }));
    expect(result.ok).toBe(false);
  });

  it('rejects keysTouched with more than the maximum allowed entries', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `gateway.key${i}`);
    const result = validateApprovalRequestedPayload(validPayload({ keysTouched: tooMany }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most 50 entries/);
  });

  it('rejects keysTouched entries that are objects instead of path strings', () => {
    const result = validateApprovalRequestedPayload(
      validPayload({ keysTouched: [{ path: 'gateway.token', value: 'sk-should-not-be-here-1234567890' }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/key paths/);
  });

  it('rejects a summary containing a bearer token', () => {
    const result = validateApprovalRequestedPayload(
      validPayload({ summary: 'Send Bearer abcdef123456 to the new host' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/secret values/);
  });

  it('rejects a summary containing a PEM private key block', () => {
    const result = validateApprovalRequestedPayload(
      validPayload({ summary: '-----BEGIN RSA PRIVATE KEY-----\nMIIB...' }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a keysTouched entry that is itself a resolved secret value', () => {
    const result = validateApprovalRequestedPayload(
      validPayload({ keysTouched: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/never secret values/);
  });

  it('accepts a plain, deep key path', () => {
    const result = validateApprovalRequestedPayload(
      validPayload({ keysTouched: ['gateway.plugins.openclaw-imajin.token', 'gateway/restart-required'] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateApprovalRequestedPayload — open vocabulary (#2152)', () => {
  it('accepts a well-formed open-vocabulary payload with source, namespaced kind, detail, and a matching contentHash', () => {
    const result = validateApprovalRequestedPayload(openVocabPayload());
    expect(result).toEqual({
      ok: true,
      source: 'skill-workshop',
      kind: 'skill-workshop:update',
      detail: { skillName: 'weather-lookup', kind: 'update', scan: 'clean' },
      contentHash: expect.any(String),
    });
  });

  it('accepts the sha256: prefixed contentHash form', () => {
    const payload = openVocabPayload();
    const result = validateApprovalRequestedPayload({ ...payload, contentHash: `sha256:${payload.contentHash}` });
    expect(result.ok).toBe(true);
  });

  it('rejects a kind not namespaced under the declared source', () => {
    const result = validateApprovalRequestedPayload(openVocabPayload({ kind: 'system-agent:restart' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/namespaced/);
  });

  it('rejects an invalid source identifier', () => {
    const result = validateApprovalRequestedPayload(openVocabPayload({ source: 'Skill Workshop!' }));
    expect(result.ok).toBe(false);
  });

  it('rejects detail that is not a JSON object', () => {
    const result = validateApprovalRequestedPayload(openVocabPayload({ detail: ['not', 'an', 'object'] }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON object/);
  });

  it('rejects detail larger than 16KB', () => {
    const detail = { diffSummary: 'x'.repeat(17 * 1024) };
    const result = validateApprovalRequestedPayload(openVocabPayload({ detail, contentHash: undefined }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/16384 bytes/);
  });

  it('requires contentHash when source is present, even with no detail', () => {
    const result = validateApprovalRequestedPayload(
      openVocabPayload({ detail: undefined, contentHash: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/contentHash is required/);
  });

  it('rejects a malformed contentHash', () => {
    const result = validateApprovalRequestedPayload(openVocabPayload({ contentHash: 'not-a-hash' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sha256 hex digest/);
  });

  // The hash-covers-detail invariant (#2152): the whole point of contentHash
  // is "what the operator saw is what gets applied" — a payload whose detail
  // was tampered with after the hash was computed must never validate.
  describe('hash-covers-detail invariant', () => {
    it('rejects when detail is tampered with after the hash was computed', () => {
      const payload = openVocabPayload();
      const tampered = { ...payload, detail: { ...payload.detail, scan: 'failed' } };
      const result = validateApprovalRequestedPayload(tampered);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match the canonical payload/);
    });

    it('rejects when detail is dropped entirely but the original hash is reused', () => {
      const payload = openVocabPayload();
      const stripped = { ...payload, detail: undefined };
      const result = validateApprovalRequestedPayload(stripped);
      expect(result.ok).toBe(false);
    });

    it('accepts two different detail payloads each with their own correctly-computed hash', () => {
      const first = validateApprovalRequestedPayload(openVocabPayload({ detail: { scan: 'clean' } }));
      const second = validateApprovalRequestedPayload(
        openVocabPayload({ proposalId: 'opap_sw_2', detail: { scan: 'failed' } }),
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      // Different detail must never collide onto the same accepted hash.
      expect(first.contentHash).not.toBe(second.contentHash);
    });
  });
});

describe('looksLikeSecretValue', () => {
  it.each([
    ['sk-live-abcdefghijklmnop'],
    ['ghp_abcdefghijklmnopqrstuvwx'],
    // Not a real Slack token shape (those are `xoxb-<digits>-<digits>-<chars>`)
    // — deliberately non-numeric so this fixture never trips GitHub's own
    // secret-scanning push protection on this very test file.
    ['xoxb-fake-test-value-not-a-real-token'],
    ['a'.repeat(40)],
    ['QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODk='],
    ['Bearer abc123def456'],
    ['-----BEGIN PRIVATE KEY-----'],
  ])('flags %s as a secret-shaped value', (value) => {
    expect(looksLikeSecretValue(value)).toBe(true);
  });

  it.each([
    ['gateway.plugins.openclaw.version'],
    ['restart-required'],
    ['config/mutation/summary'],
  ])('does not flag the plain key path %s', (value) => {
    expect(looksLikeSecretValue(value)).toBe(false);
  });
});

describe('isOperatorIdentity', () => {
  it('is true for the operator authenticated directly', () => {
    expect(isOperatorIdentity(operatorIdentity(), OPERATOR_DID)).toBe(true);
  });

  it('is false for a different authenticated human', () => {
    expect(isOperatorIdentity(otherHumanIdentity(), OPERATOR_DID)).toBe(false);
  });

  it('is false for an agent acting for the operator via X-Acting-For (#2059 load-bearing rule)', () => {
    expect(isOperatorIdentity(agentActingForOperatorIdentity(), OPERATOR_DID)).toBe(false);
  });

  it('is false when the id happens to match but actingFor is also set', () => {
    // Defensive: even if some future path ever produced this combination,
    // the explicit actingFor check must still reject it.
    const identity = { id: OPERATOR_DID, scope: 'actor', actingFor: 'did:imajin:someone' };
    expect(isOperatorIdentity(identity, OPERATOR_DID)).toBe(false);
  });
});

describe('getOperatorDid', () => {
  beforeEach(() => {
    mockGetNodeSelfInfo.mockReset();
  });

  it('returns relay_config.node_operator_did when configured', async () => {
    mockGetNodeSelfInfo.mockResolvedValueOnce({
      did: 'did:imajin:node',
      nodeOperatorDid: OPERATOR_DID,
      nodeFeeBps: 50,
      buyerCreditBps: 25,
    });
    expect(await getOperatorDid()).toBe(OPERATOR_DID);
  });

  it('returns null when no operator is configured', async () => {
    mockGetNodeSelfInfo.mockResolvedValueOnce({
      did: 'did:imajin:node',
      nodeOperatorDid: null,
      nodeFeeBps: 50,
      buyerCreditBps: 25,
    });
    expect(await getOperatorDid()).toBeNull();
  });

  it('returns null when the node itself is unconfigured', async () => {
    mockGetNodeSelfInfo.mockResolvedValueOnce(null);
    expect(await getOperatorDid()).toBeNull();
  });
});
