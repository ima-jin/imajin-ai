/**
 * Tests for the /jin confirm-rail act-as guard (#2359).
 *
 * The guard is pure (no DB, no network), so this suite runs it for real
 * against the same identity fixtures the decide/list route tests use.
 */
import { describe, it, expect } from 'vitest';
import {
  GROUP_DID,
  OPERATOR_DID,
  AGENT_DID,
  operatorIdentity,
  agentActingForOperatorIdentity,
  operatorActingAsGroupIdentity,
} from './operator-approvals-test-helpers';
import {
  ACT_AS_NOT_PERMITTED,
  actAsContext,
  actAsRefusal,
} from '../act-as-guard';

describe('actAsContext (#2359)', () => {
  it('is null for a plain session that is only ever itself', () => {
    expect(actAsContext(operatorIdentity())).toBeNull();
  });

  it('names both identities for the operator carrying an x-acting-as cookie', () => {
    expect(actAsContext(operatorActingAsGroupIdentity())).toEqual({
      sessionDid: OPERATOR_DID,
      actingDid: GROUP_DID,
    });
  });

  it('names both identities for an agent holding X-Acting-For', () => {
    expect(actAsContext(agentActingForOperatorIdentity())).toEqual({
      sessionDid: AGENT_DID,
      actingDid: OPERATOR_DID,
    });
  });
});

describe('actAsRefusal (#2359)', () => {
  it('lets a plain session through with no response at all', () => {
    expect(actAsRefusal(operatorIdentity(), new Headers())).toBeNull();
  });

  it('refuses an act-as session with 403 act_as_not_permitted', async () => {
    const res = actAsRefusal(operatorActingAsGroupIdentity(), new Headers());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { code: string; sessionDid: string; actingDid: string; error: string };
    expect(body.code).toBe(ACT_AS_NOT_PERMITTED);
    expect(body.sessionDid).toBe(OPERATOR_DID);
    expect(body.actingDid).toBe(GROUP_DID);
    expect(body.error).toContain('self-only');
  });

  it('refuses an agent acting for the operator with the same code', async () => {
    const res = actAsRefusal(agentActingForOperatorIdentity(), new Headers());

    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { code: string };
    expect(body.code).toBe(ACT_AS_NOT_PERMITTED);
  });
});
