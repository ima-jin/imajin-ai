import { describe, expect, it } from 'vitest';
import { projectHorizon, type HorizonLease } from '../horizon';
import {
  CODE_STEP, STEP_CLAIM, STEP_ISSUE, STEP_ISSUE_UPDATE, STEP_NOW, STEP_PRINCIPAL, STEP_READY,
  STEP_REPOSITORY, closureStep, deployedStep, observedStep, queuedStep, releaseStep, stepEvent,
} from './horizon-fixtures';

const lease: HorizonLease = {
  surface: 'step:step-2878', loopId: 'cycle', principal: STEP_PRINCIPAL,
  holderDid: STEP_PRINCIPAL, acquiredAt: new Date(STEP_NOW).toISOString(), expiresAt: STEP_CLAIM.expiresAt,
};
const project = (events: ReturnType<typeof stepEvent>[], now = STEP_NOW, leases: HorizonLease[] = []) =>
  projectHorizon(events, 'cycle', STEP_PRINCIPAL, now, false, leases);

describe('signed horizon projection', () => {
  it('moves tail → middle → near → head → past → gone using facts, not authored zones', () => {
    const events = [queuedStep()];
    expect(project(events).steps[0]).toMatchObject({ state: 'queued', zone: 'tail', rank: 10, openExitConditions: ['closed', 'released', 'prod'] });
    events.push(stepEvent('step.updated', 1, { update: STEP_ISSUE_UPDATE }));
    expect(project(events).steps[0].zone).toBe('middle');
    events.push(stepEvent('step.updated', 2, { update: STEP_READY }));
    expect(project(events).steps[0].zone).toBe('near');
    events.push(stepEvent('step.claimed', 3, { claim: STEP_CLAIM }));
    expect(project(events, STEP_NOW, [lease]).steps[0]).toMatchObject({
      zone: 'head', state: 'claimed', claim: { ...STEP_CLAIM, leaseId: lease.surface, acquiredAt: lease.acquiredAt },
    });
    events.push(stepEvent('step.started', 4));
    expect(project(events).steps[0].state).toBe('running');
    events.push(stepEvent('step.finished', 5), closureStep());
    expect(project(events).steps[0]).toMatchObject({ zone: 'past', state: 'finished', openExitConditions: ['released', 'prod'] });
    events.push(releaseStep());
    expect(project(events).steps[0]).toMatchObject({ zone: 'past', openExitConditions: ['prod'] });
    events.push(deployedStep());
    expect(project(events)).toEqual({ steps: [], depth: 0, targetDepth: 12 });
    const audit = projectHorizon(events, 'cycle', STEP_PRINCIPAL, STEP_NOW, true);
    expect(audit.depth).toBe(0);
    expect(audit.steps[0]).toMatchObject({ state: 'exited', zone: 'done', openExitConditions: [] });
    expect(audit.steps[0].conditions.every(condition => condition.satisfied && condition.evidence)).toBe(true);
    expect(events).toHaveLength(9); // audit history survives invisibility
  });

  it('rebuilds identically from serialized, shuffled durable history without an agent session', () => {
    const events = [queuedStep(), stepEvent('step.updated', 1, { update: STEP_ISSUE_UPDATE }), closureStep(), releaseStep()];
    const snapshot = JSON.stringify(events);
    const restored = JSON.parse(snapshot).reverse();
    expect(project(restored)).toEqual(project(events));
    expect(JSON.stringify(events)).toBe(snapshot);
    expect(project(events).steps[0].conditions[1].evidence).toMatchObject({
      eventId: releaseStep().id, issuer: STEP_PRINCIPAL, fact: { tag: 'v1.0.0', mergeCommit: 'a'.repeat(40) },
    });
  });

  it.each(['step.started', 'step.progress', 'step.blocked', 'step.finished'] as const)('projects %s without treating lifecycle completion as exit', type => {
    const result = project([queuedStep(), stepEvent(type, 1)]);
    expect(result.depth).toBe(1);
    expect(result.steps[0].state).toBe({ 'step.started': 'running', 'step.progress': 'running', 'step.blocked': 'blocked', 'step.finished': 'finished' }[type]);
  });

  it('derives head only from an authoritative unexpired lease, never a signed claim reference alone', () => {
    const events = [queuedStep(), stepEvent('step.updated', 1, { update: { ...STEP_ISSUE_UPDATE, ...STEP_READY } }),
      stepEvent('step.claimed', 2, { claim: STEP_CLAIM })];
    expect(project(events).steps[0]).toMatchObject({ state: 'queued', zone: 'near' });
    expect(project(events).steps[0]).not.toHaveProperty('claim');
    expect(project(events, Date.parse(STEP_CLAIM.expiresAt), [lease]).steps[0].zone).toBe('near');
    expect(project(events, STEP_NOW, [lease]).steps[0].zone).toBe('head');
    expect(project(events, STEP_NOW, [{ ...lease, principal: 'did:imajin:other' }]).steps[0].zone).toBe('near');
    expect(project(events, STEP_NOW, [{ ...lease, loopId: 'other' }]).steps[0].zone).toBe('near');
  });

  it('requires all readiness facts and retains rank zero with a deterministic stepId tie-break', () => {
    const events = ['z', 'a', 'b'].map(stepId => stepEvent('step.queued', 0, { step: { ...CODE_STEP, rank: 0 } }, stepId));
    events.push(stepEvent('step.updated', 1, { update: { ...STEP_ISSUE_UPDATE, briefRef: 'brief' } }, 'a'));
    expect(project(events).steps.map(step => step.stepId)).toEqual(['a', 'b', 'z']);
    expect(project(events).steps[0].zone).toBe('middle');
    events.push(stepEvent('step.updated', 2, { update: { rank: -1 } }, 'z'));
    expect(project(events).steps[0].stepId).toBe('z');
    expect(project(events).depth).toBe(3);
  });

  it('does not cap depth or silently discard the thirteenth pending entry', () => {
    const events = Array.from({ length: 13 }, (_, rank) => stepEvent('step.queued', rank, { step: { ...CODE_STEP, rank } }, `step-${rank}`));
    expect(project(events)).toMatchObject({ depth: 13, targetDepth: 12 });
  });

  it('ignores undeclared, mistyped and unrelated release evidence and never pairs different tags', () => {
    const base = [queuedStep(), stepEvent('step.updated', 1, { update: STEP_ISSUE_UPDATE }), closureStep()];
    const badFacts = [
      observedStep(7, 'unknown', { kind: 'issue_closed', issue: STEP_ISSUE }),
      observedStep(8, 'released', { kind: 'issue_closed', issue: STEP_ISSUE }),
      observedStep(9, 'released', { kind: 'release_contains', repository: 'other/repo', issue: STEP_ISSUE, mergeCommit: 'a'.repeat(40), tag: 'v1.0.0' }),
      deployedStep(),
    ];
    expect(project([...base, ...badFacts]).steps[0].openExitConditions).toEqual(['released', 'prod']);
    const wrongIssue = observedStep(10, 'released', { kind: 'release_contains', repository: STEP_REPOSITORY, issue: 'other#1', mergeCommit: 'a'.repeat(40), tag: 'v1.0.0' });
    expect(project([...base, deployedStep(), wrongIssue]).steps[0].openExitConditions).toEqual(['released', 'prod']);
    const wrongTag = observedStep(9, 'prod', { kind: 'deployed', repository: STEP_REPOSITORY, tag: 'v2.0.0', environment: 'prod' });
    expect(project([...base, releaseStep(), wrongTag]).steps[0].openExitConditions).toEqual(['prod']);
    const wrongRepository = observedStep(9, 'prod', { kind: 'deployed', repository: 'other/repo', tag: 'v1.0.0', environment: 'prod' });
    expect(project([...base, releaseStep(), wrongRepository]).steps[0].openExitConditions).toEqual(['prod']);
  });

  it('never equates an unrelated closed issue with this step closing', () => {
    const result = project([queuedStep(), stepEvent('step.updated', 1, { update: STEP_ISSUE_UPDATE }),
      observedStep(2, 'closed', { kind: 'issue_closed', issue: 'other#1' })]);
    expect(result.steps[0].zone).toBe('middle');
    expect(result.steps[0].openExitConditions).toContain('closed');
  });

  it.each(['human', 'ops'] as const)('keeps a %s item until its completing DID attests, preserving the attestation in history', stepKind => {
    const queue = stepEvent('step.queued', 0, { step: {
      stepKind, intention: 'Approve the runbook', rank: 1,
      exitConditions: [{ id: 'manual', kind: 'attestation', attestorDid: STEP_PRINCIPAL }],
    } });
    const attested = stepEvent('step.attested', 2, { attestation: { conditionId: 'manual', did: STEP_PRINCIPAL, statement: 'I completed this work' } });
    const otherDid = 'did:imajin:someone-else';
    const other = { ...attested, issuer: otherDid, payload: { ...attested.payload, attestation: { conditionId: 'manual', did: otherDid, statement: 'I did it' } } };
    const wrongKind = observedStep(2, 'manual', { kind: 'issue_closed', issue: STEP_ISSUE });
    expect(project([queue, stepEvent('step.finished', 1), other, wrongKind]).depth).toBe(1);
    const history = [queue, attested];
    expect(project(history).depth).toBe(0);
    expect(history[1].payload.attestation).toMatchObject({ did: STEP_PRINCIPAL, statement: 'I completed this work' });
  });

  it('ignores malformed, unqueued, foreign-principal and foreign-loop observations', () => {
    const invalid = stepEvent('step.updated', 1, { update: { zone: 'head' } });
    const foreign = { ...queuedStep(), principal: 'did:imajin:other' };
    const otherLoop = { ...queuedStep(), loopId: 'other' };
    const unknown = { ...queuedStep(), type: 'other.event' };
    expect(project([stepEvent('step.finished', 1), invalid, foreign, otherLoop, unknown]).depth).toBe(0);
    expect(project([queuedStep(), invalid]).steps[0].zone).toBe('tail');
  });

  it('retains the first immutable declaration even when a retry attempts to erase conditions', () => {
    const retry = stepEvent('step.queued', 1, { step: { ...CODE_STEP, intention: 'Changed', rank: -99 } });
    expect(project([queuedStep(), retry, queuedStep()]).steps[0]).toMatchObject({ intention: CODE_STEP.intention, rank: 10 });
  });

  it('replays co-timestamped facts even when their signed id sorts before the declaration, but ignores pre-queue facts', () => {
    const queue = { ...queuedStep(), id: 'z-queue' };
    const update = { ...stepEvent('step.updated', 0, { update: STEP_ISSUE_UPDATE }), id: 'a-update' };
    const premature = stepEvent('step.updated', -1, { update: STEP_READY });
    const result = project([update, premature, queue]);
    expect(result.steps[0].zone).toBe('middle');
    expect(result.steps[0].issue).toEqual(STEP_ISSUE_UPDATE.issue);
    expect(result.steps[0]).not.toHaveProperty('briefRef');
    expect(project([queue, update, premature])).toEqual(result);
  });
});
