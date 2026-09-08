/**
 * Tests for the operator-approvals contract module (#2059): payload
 * validation (including the secret-redaction boundary, acceptance (e)) and
 * the load-bearing `isOperatorIdentity` auth invariant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetNodeSelfInfo } = vi.hoisted(() => ({ mockGetNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: mockGetNodeSelfInfo }));

import {
  validateApprovalRequestedPayload,
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

describe('validateApprovalRequestedPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateApprovalRequestedPayload(validPayload())).toEqual({ ok: true });
  });

  it('accepts an empty keysTouched array', () => {
    expect(validateApprovalRequestedPayload(validPayload({ keysTouched: [] }))).toEqual({ ok: true });
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
