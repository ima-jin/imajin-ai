import { describe, expect, it } from 'vitest';
import { projectHorizon } from '../horizon';
import { SURFACE_LEASE_TTL_MS } from '../surface-lease-policy';
import {
  STEP_ISSUE_UPDATE, STEP_NOW, STEP_PRINCIPAL, closureStep, deployedStep, queuedStep,
  releaseStep, stepEvent, stepLeaseEvent,
} from './horizon-fixtures';

const holder = 'did:imajin:holder';
const stranger = 'did:imajin:stranger';
const project = (events: ReturnType<typeof stepEvent>[], now = STEP_NOW) =>
  projectHorizon(events, 'cycle', STEP_PRINCIPAL, now, true);
const holderFact = (type: 'step.updated' | 'step.finished', sequence: number) =>
  ({ ...stepEvent(type, sequence, type === 'step.updated' ? { update: STEP_ISSUE_UPDATE } : {}), issuer: holder });
const acquired = () => stepLeaseEvent('surface.acquired', 1, holder);

describe('event-time step lease authority', () => {
  it.each(['released', 'expired', 'loop-finished'] as const)(
    'keeps holder updates/finish and matching exit evidence after the lease is %s', ending => {
      const events = [queuedStep(), acquired(), holderFact('step.updated', 2), holderFact('step.finished', 3)];
      if (ending === 'released') events.push(stepLeaseEvent('surface.released', 4, holder));
      if (ending === 'loop-finished') events.push(stepLeaseEvent('loop.finished', 4, holder));
      const now = STEP_NOW + SURFACE_LEASE_TTL_MS * 2;
      expect(project(events, now).steps[0]).toMatchObject({
        publisher: STEP_PRINCIPAL, issue: STEP_ISSUE_UPDATE.issue, state: 'finished', zone: 'middle',
      });
      expect(project(events, now).steps[0]).not.toHaveProperty('claim');
      events.push(closureStep(), releaseStep(), deployedStep());
      const snapshot = JSON.stringify(events);
      expect(project(events, now).steps[0]).toMatchObject({
        issue: STEP_ISSUE_UPDATE.issue, state: 'exited', zone: 'done', openExitConditions: [],
      });
      expect(project(structuredClone(events).reverse(), now)).toEqual(project(events, now));
      expect(JSON.stringify(events)).toBe(snapshot);
    },
  );

  it.each(['surface.released', 'loop.finished'])('refuses holder facts at and after %s', type => {
    const events = [queuedStep(), acquired(), holderFact('step.updated', 2), holderFact('step.finished', 3),
      stepLeaseEvent(type, 4, holder)];
    for (const sequence of [4, 5]) {
      const bad = { ...holderFact('step.updated', sequence), payload: {
        ...holderFact('step.updated', sequence).payload, update: { issue: { ref: 'wrong/repo#1' } },
      } };
      events.push(bad, { ...stepEvent('step.blocked', sequence), issuer: holder });
    }
    expect(project(events).steps[0]).toMatchObject({ state: 'finished', issue: STEP_ISSUE_UPDATE.issue });
  });

  it('refuses holder facts at the exact expiry boundary or later, but accepts just before it', () => {
    const queue = queuedStep();
    const acquisition = acquired();
    const expiry = Date.parse(acquisition.occurredAt) + SURFACE_LEASE_TTL_MS;
    for (const offset of [-1, 0, 1]) {
      const finished = { ...holderFact('step.finished', 2), occurredAt: new Date(expiry + offset).toISOString() };
      expect(project([queue, acquisition, finished], expiry + 1000).steps[0].state)
        .toBe(offset < 0 ? 'finished' : 'queued');
    }
  });

  it.each([
    { loopId: 'other' }, { principal: 'did:imajin:other' },
    { issuer: stranger }, { payload: { surface: 'step:other' } },
  ])('refuses authority from a foreign lease: %j', mismatch => {
    const events = [queuedStep(), { ...acquired(), ...mismatch }, holderFact('step.finished', 3)];
    expect(project(events).steps[0].state).toBe('queued');
  });

  it('never authorizes a stranger or a pre-acquisition fact', () => {
    const events = [queuedStep(), holderFact('step.updated', 0), acquired(),
      { ...stepEvent('step.finished', 3), issuer: stranger }];
    expect(project(events).steps[0]).toMatchObject({ state: 'queued', zone: 'tail' });
    expect(project(events).steps[0]).not.toHaveProperty('issue');
  });

  it('renews through a fresh same-holder acquisition without losing prior authorized fields', () => {
    const events = [queuedStep(), acquired(), holderFact('step.updated', 2),
      stepLeaseEvent('surface.acquired', 601, holder), holderFact('step.finished', 1001)];
    expect(project(events, STEP_NOW + SURFACE_LEASE_TTL_MS * 3).steps[0])
      .toMatchObject({ state: 'finished', issue: STEP_ISSUE_UPDATE.issue });
  });

  it('does not fill an expired gap retroactively when the same DID reacquires', () => {
    const events = [queuedStep(), acquired(), holderFact('step.updated', 2), holderFact('step.finished', 902),
      stepLeaseEvent('surface.acquired', 1001, holder)];
    expect(project(events).steps[0]).toMatchObject({ state: 'queued', issue: STEP_ISSUE_UPDATE.issue });
    events.push(holderFact('step.finished', 1002));
    expect(project(events).steps[0].state).toBe('finished');
  });

  it('retains the first holder’s work after another holder acquires without authorizing old-holder facts later', () => {
    const events = [queuedStep(), acquired(), holderFact('step.updated', 2), holderFact('step.finished', 3),
      stepLeaseEvent('surface.released', 4, holder), stepLeaseEvent('surface.acquired', 5, stranger),
      { ...stepEvent('step.blocked', 6), issuer: holder }];
    expect(project(events).steps[0]).toMatchObject({ state: 'finished', issue: STEP_ISSUE_UPDATE.issue });
    events.push({ ...stepEvent('step.blocked', 7), issuer: stranger });
    expect(project(events).steps[0].state).toBe('blocked');
  });

  it('ignores another DID’s releases/completions and acquisitions that conflict with a live holder', () => {
    const events = [queuedStep(), acquired(), stepLeaseEvent('surface.released', 2, stranger),
      stepLeaseEvent('loop.finished', 2, stranger), stepLeaseEvent('surface.acquired', 2, stranger),
      stepLeaseEvent('surface.conflicted', 2, stranger), holderFact('step.finished', 3)];
    expect(project(events).steps[0].state).toBe('finished');
    events.push({ ...stepEvent('step.blocked', 4), issuer: stranger });
    expect(project(events).steps[0].state).toBe('finished');
  });

  it('does not grant rights from cross-loop conflict history even after the conflicting holding expires', () => {
    const events = [queuedStep(), stepLeaseEvent('surface.acquired', 1, holder, {
      observedConflictingLoopId: 'foreign-loop',
    }), holderFact('step.finished', 3)];
    expect(project(events, STEP_NOW + SURFACE_LEASE_TTL_MS * 2).steps[0].state).toBe('queued');
  });

  it('does not renew a step with loop progress, a retry, or an unknown heartbeat event', () => {
    for (const heartbeat of [stepLeaseEvent('loop.progress', 601, holder),
      stepLeaseEvent('surface.heartbeat', 601, holder), acquired()]) {
      expect(project([queuedStep(), acquired(), heartbeat, holderFact('step.finished', 902)]).steps[0].state).toBe('queued');
    }
  });

  it('uses acquisition/release timestamps rather than signed-id order for co-timestamped facts', () => {
    const acquire = { ...acquired(), id: 'z-acquire' };
    const finish = { ...holderFact('step.finished', 1), id: 'a-finish' };
    expect(project([queuedStep(), finish, acquire]).steps[0].state).toBe('finished');
    const release = { ...stepLeaseEvent('surface.released', 1, holder), id: '0-release' };
    expect(project([queuedStep(), finish, acquire, release]).steps[0].state).toBe('queued');
  });

  it('ignores invalid lease timestamps and unrelated surface identities', () => {
    const events = [queuedStep(), { ...acquired(), occurredAt: 'invalid' },
      stepLeaseEvent('surface.acquired', 1, holder, { surface: 'issue:#3151' }),
      stepLeaseEvent('surface.acquired', 1, holder, { surface: 'step:invalid space' }), holderFact('step.finished', 3)];
    expect(project(events).steps[0].state).toBe('queued');
  });
});
