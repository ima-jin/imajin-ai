import { describe, expect, it } from 'vitest';
import type { Identity } from '@imajin/auth';
import { resolveApprovalDid } from '../channel-link-approval';

const human: Identity = { id: 'did:imajin:human', scope: 'actor', subtype: 'human' };
const org = 'did:imajin:org';

describe('channel-link approval binding is explicit', () => {
  it.each([undefined, 'self'])('defaults %s to the user despite acting-as or acting-for context', bindAs => {
    for (const context of [{}, { actingAs: org }, { actingFor: 'did:imajin:other-human' }]) {
      expect(resolveApprovalDid({ ...human, ...context }, bindAs)).toEqual({ did: human.id });
    }
  });
  it('opts into the verified acting org only when explicitly requested', () => {
    expect(resolveApprovalDid({ ...human, actingAs: org }, 'org')).toEqual({ did: org });
  });
  it.each([{}, { actingAs: human.id }, { actingFor: 'did:imajin:other-human' },
    { actingAs: org, actingFor: 'did:imajin:other-human' }])('refuses org binding without usable org context %j', context => {
    expect(resolveApprovalDid({ ...human, ...context }, 'org')).toEqual({
      error: 'bindAs=org requires acting as an org', status: 403,
    });
  });
  it.each([null, '', 'ORG', 'human', false, 0, {}, ['org']])('rejects invalid selector %j', bindAs => {
    expect(resolveApprovalDid({ ...human, actingAs: org }, bindAs)).toEqual({ error: 'invalid bindAs', status: 400 });
  });
});
