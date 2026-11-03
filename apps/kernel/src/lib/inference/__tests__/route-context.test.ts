import { describe, expect, it } from 'vitest';
import { resolveInferenceRouteContext } from '../route-context';
import type { Identity } from '@imajin/auth';

const ACTOR = 'did:imajin:agent';
const HUMAN = 'did:imajin:human';
const ORG = 'did:imajin:org';
const APP = 'did:imajin:app';
describe('one pure route context for auth/call and discovery', () => {
  it.each([
    { actorDid: ACTOR },
    { actorDid: ACTOR, actingAs: ORG },
    { actorDid: ACTOR, actingFor: HUMAN },
    { actorDid: ACTOR, actingFor: HUMAN, actingAs: ORG },
    { actorDid: HUMAN, actingAs: ORG },
  ])('projects identical app-auth and discovery context for %j', caller => {
    const app = { appDid: APP, userDid: caller.actorDid, scopes: ['infer:completions'], attestationId: 'fixture', ...caller };
    expect(resolveInferenceRouteContext({ app })).toEqual(resolveInferenceRouteContext({ caller, appDid: APP }));
  });
  it.each([
    { actorDid: ACTOR },
    { actorDid: ACTOR, actingAs: ORG },
    { actorDid: ACTOR, actingFor: HUMAN },
    { actorDid: ACTOR, actingFor: HUMAN, actingAs: ORG },
  ])('projects identical agent-session and discovery context for %j', caller => {
    const identity: Identity = { id: ACTOR, scope: 'actor', subtype: 'agent', ...caller };
    expect(resolveInferenceRouteContext({ identity })).toEqual(resolveInferenceRouteContext({ caller }));
  });
  it('preserves the personal session owner-only contract', () => {
    expect(resolveInferenceRouteContext({ identity: { id: HUMAN, scope: 'actor', subtype: 'human' } })).toEqual({
      ok: true, context: { ownerDid: HUMAN },
    });
  });
  it('rejects conflicting non-agent selectors and missing app delegation exactly as authentication does', () => {
    expect(resolveInferenceRouteContext({ identity: {
      id: HUMAN, scope: 'actor', subtype: 'human', actingFor: HUMAN, actingAs: ORG,
    } })).toMatchObject({ ok: false, status: 403 });
    expect(resolveInferenceRouteContext({ app: {
      userDid: '', appDid: APP, scopes: [], attestationId: '',
    } })).toMatchObject({ ok: false, status: 400 });
  });
});
