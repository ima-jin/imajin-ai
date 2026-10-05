import { describe, it, expect, vi, beforeEach } from 'vitest';

const { introspectGrant } = vi.hoisted(() => ({ introspectGrant: vi.fn() }));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant }));

import {
  DEFAULT_EVIDENTIARY_TOOLS,
  EVIDENTIARY_TOOLS_ENV,
  getEvidentiaryTools,
  isEvidentiaryTool,
} from '../config';
import { TURN_EVENT_TYPES, toTurnEventRef } from '../turn-event';
import { EVIDENCE_PUBLISH_CAPABILITY, authorizeEvidencePublisher } from '../authorize-publisher';
import { AGENT_DID, CLAIM_HASH, PRINCIPAL_DID, TURN_EVENT_ID } from './helpers';

describe('evidentiary-tool allowlist (config)', () => {
  it('defaults to the narrow built-in list when unset', () => {
    expect([...getEvidentiaryTools({})]).toEqual([...DEFAULT_EVIDENTIARY_TOOLS]);
    expect(isEvidentiaryTool('web_fetch', {})).toBe(true);
    expect(isEvidentiaryTool('send_email', {})).toBe(false);
  });

  it('reads a comma-separated override, trimming blanks', () => {
    const env = { [EVIDENTIARY_TOOLS_ENV]: ' eth_getCode , ,web_fetch,' };
    expect([...getEvidentiaryTools(env)]).toEqual(['eth_getCode', 'web_fetch']);
    expect(isEvidentiaryTool('eth_getCode', env)).toBe(true);
    expect(isEvidentiaryTool('chain_read', env)).toBe(false); // override replaces, not extends, the default
  });

  it('treats an explicitly empty value as "retain nothing"', () => {
    const env = { [EVIDENTIARY_TOOLS_ENV]: '' };
    expect(getEvidentiaryTools(env).size).toBe(0);
    expect(isEvidentiaryTool('web_fetch', env)).toBe(false);
  });

  it('reads process.env by default', () => {
    expect(isEvidentiaryTool('web_fetch')).toBe(true);
  });
});

describe('toTurnEventRef (#1970 seam)', () => {
  const row = (overrides = {}) => ({
    id: TURN_EVENT_ID,
    eventType: TURN_EVENT_TYPES[0],
    issuer: AGENT_DID,
    payload: { outputHash: CLAIM_HASH, usageRef: 'att_u1', transcript: 'must never be copied' },
    createdAt: new Date('2026-09-04T00:00:00Z'),
    ...overrides,
  });

  it('maps a turn event to the minimal view, copying only outputHash and usageRef from the payload', () => {
    const ref = toTurnEventRef(row());
    expect(ref).toEqual({
      id: TURN_EVENT_ID,
      eventType: 'agent.turn',
      issuer: AGENT_DID,
      occurredAt: new Date('2026-09-04T00:00:00Z'),
      outputHash: CLAIM_HASH,
      usageRef: 'att_u1',
    });
    expect(JSON.stringify(ref)).not.toContain('transcript');
  });

  it('normalizes a bare-hex outputHash and tolerates missing/odd payloads', () => {
    expect(toTurnEventRef(row({ payload: { outputHash: CLAIM_HASH.slice(7).toUpperCase() } }))?.outputHash).toBe(CLAIM_HASH);
    expect(toTurnEventRef(row({ payload: { outputHash: 'not a hash' } }))?.outputHash).toBeNull();
    expect(toTurnEventRef(row({ payload: {} }))).toMatchObject({ outputHash: null, usageRef: null });
    expect(toTurnEventRef(row({ payload: null }))).toMatchObject({ outputHash: null, usageRef: null });
    expect(toTurnEventRef(row({ payload: 'string payload' }))).toMatchObject({ outputHash: null, usageRef: null });
    expect(toTurnEventRef(row({ payload: { outputHash: '' } }))?.outputHash).toBeNull();
  });

  it('is null for any event type that is not a turn event', () => {
    expect(toTurnEventRef(row({ eventType: 'attestation.created' }))).toBeNull();
  });
});

describe('authorizeEvidencePublisher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes self-attestation without consulting grants', async () => {
    expect(await authorizeEvidencePublisher(AGENT_DID, AGENT_DID)).toEqual({ authorized: true, grantId: null });
    expect(introspectGrant).not.toHaveBeenCalled();
  });

  it('authorizes an agent holding an active evidence:publish grant from the principal, returning the grant id', async () => {
    introspectGrant.mockResolvedValueOnce({ authorized: true, grantId: 'grant_42' });

    expect(await authorizeEvidencePublisher(AGENT_DID, PRINCIPAL_DID)).toEqual({ authorized: true, grantId: 'grant_42' });
    expect(introspectGrant).toHaveBeenCalledWith({
      agentDid: AGENT_DID,
      capability: EVIDENCE_PUBLISH_CAPABILITY,
      delegatorDid: PRINCIPAL_DID,
      targetDid: PRINCIPAL_DID,
    });
    expect(EVIDENCE_PUBLISH_CAPABILITY).toBe('evidence:publish');
  });

  it('tolerates an authorized introspection with no grant id', async () => {
    introspectGrant.mockResolvedValueOnce({ authorized: true });
    expect(await authorizeEvidencePublisher(AGENT_DID, PRINCIPAL_DID)).toEqual({ authorized: true, grantId: null });
  });

  it('denies when no live grant covers the principal', async () => {
    introspectGrant.mockResolvedValueOnce({ authorized: false, reason: 'no grant' });
    expect(await authorizeEvidencePublisher(AGENT_DID, PRINCIPAL_DID)).toEqual({ authorized: false });
  });

  it('fails closed: a storage error propagates rather than authorizing', async () => {
    introspectGrant.mockRejectedValueOnce(new Error('db down'));
    await expect(authorizeEvidencePublisher(AGENT_DID, PRINCIPAL_DID)).rejects.toThrow('db down');
  });
});
