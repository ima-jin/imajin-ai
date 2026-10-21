import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectHorizon } from '../horizon';
import {
  STEP_ISSUE, STEP_ISSUE_UPDATE, STEP_NOW, STEP_PRINCIPAL, STEP_READY, STEP_REPOSITORY,
  closureStep, deployedStep, observedStep, queuedStep, releaseStep, stepEvent,
} from './horizon-fixtures';

const project = (events: ReturnType<typeof stepEvent>[], includeExited = false) =>
  projectHorizon(events, 'cycle', STEP_PRINCIPAL, STEP_NOW, includeExited);
const bound = () => [
  queuedStep(),
  stepEvent('step.updated', 1, { update: { issue: { ref: STEP_ISSUE } } }),
  stepEvent('step.finished', 2),
];
const fetch = vi.fn(() => { throw new Error('Binding projection must not perform network calls'); });
beforeEach(() => { fetch.mockClear(); vi.stubGlobal('fetch', fetch); });
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetch).not.toHaveBeenCalled();
});

describe('ref-only horizon issue binding', () => {
  it('moves queue → ref-only update → finished → issue_closed to past without inventing an outcome', () => {
    const events = bound();
    expect(project(events.slice(0, 1)).steps[0].zone).toBe('tail');
    expect(project(events.slice(0, 2)).steps[0]).toMatchObject({
      issue: { ref: STEP_ISSUE }, zone: 'tail', state: 'queued',
    });
    expect(project(events).steps[0]).toMatchObject({
      state: 'finished', zone: 'tail', openExitConditions: ['closed', 'released', 'prod'],
    });
    events.push(closureStep());
    const snapshot = JSON.stringify(events);
    const horizon = project(events);
    expect(horizon).toMatchObject({ depth: 1, steps: [{
      issue: { ref: STEP_ISSUE }, state: 'finished', zone: 'past', openExitConditions: ['released', 'prod'],
    }] });
    expect(horizon.steps[0].conditions.map(condition => condition.satisfied)).toEqual([true, false, false]);
    expect(horizon.steps[0].conditions[0].evidence).toMatchObject({
      eventId: closureStep().id, fact: { kind: 'issue_closed', issue: STEP_ISSUE },
    });
    expect(horizon.steps[0].issue).not.toHaveProperty('outcome');
    expect(project(JSON.parse(snapshot).reverse())).toEqual(horizon);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('does not close a ref-only binding for an unrelated issue', () => {
    const unrelated = observedStep(6, 'closed', { kind: 'issue_closed', issue: 'other/repo#1' });
    expect(project([...bound(), unrelated]).steps[0]).toMatchObject({
      zone: 'tail', state: 'finished', openExitConditions: ['closed', 'released', 'prod'],
    });
  });

  it('exits only after matching release and production deployment facts, retaining ref-only audit history', () => {
    const events = [...bound(), closureStep()];
    expect(project([...events, deployedStep()]).steps[0].openExitConditions).toEqual(['released', 'prod']);
    events.push(releaseStep());
    expect(project(events).steps[0].openExitConditions).toEqual(['prod']);
    events.push(deployedStep());
    expect(project(events)).toEqual({ depth: 0, steps: [], targetDepth: 12 });
    const audit = project(events, true);
    expect(audit.steps[0]).toMatchObject({
      issue: { ref: STEP_ISSUE }, state: 'exited', zone: 'done', openExitConditions: [],
    });
    expect(audit.steps[0].conditions.every(condition => condition.satisfied)).toBe(true);
    expect(audit.steps[0].issue).not.toHaveProperty('outcome');
  });

  it.each([
    { repository: 'other/repo', issue: STEP_ISSUE },
    { repository: STEP_REPOSITORY, issue: 'other/repo#1' },
  ])('rejects a release mismatching the ref-only binding: %j', fields => {
    const release = observedStep(7, 'released', {
      kind: 'release_contains', ...fields, mergeCommit: 'a'.repeat(40), tag: 'v1.0.0',
    });
    expect(project([...bound(), closureStep(), release, deployedStep()]).steps[0]).toMatchObject({
      zone: 'past', openExitConditions: ['released', 'prod'],
    });
  });

  it.each([
    { repository: 'other/repo', tag: 'v1.0.0' },
    { repository: STEP_REPOSITORY, tag: 'v2.0.0' },
  ])('rejects a deployment mismatching the bound release: %j', fields => {
    const deployment = observedStep(8, 'prod', { kind: 'deployed', ...fields, environment: 'prod' });
    expect(project([...bound(), closureStep(), releaseStep(), deployment]).steps[0]).toMatchObject({
      zone: 'past', openExitConditions: ['prod'],
    });
  });

  it('sharpens an issue with a real OUTCOME to middle', () => {
    const update = stepEvent('step.updated', 1, { update: STEP_ISSUE_UPDATE });
    expect(project([queuedStep(), update]).steps[0]).toMatchObject({
      issue: STEP_ISSUE_UPDATE.issue, zone: 'middle', state: 'queued',
    });
  });

  it.each([
    { refs: {}, sharpenedZone: 'middle' },
    { refs: STEP_READY, sharpenedZone: 'near' },
  ])('keeps a ref-only step tail until a real OUTCOME promotes it to $sharpenedZone', ({ refs, sharpenedZone }) => {
    const events = [...bound(), stepEvent('step.updated', 3, { update: { issue: { ref: STEP_ISSUE }, ...refs } })];
    expect(project(events).steps[0]).toMatchObject({ zone: 'tail', state: 'finished' });
    const update = stepEvent('step.updated', 4, { update: STEP_ISSUE_UPDATE });
    expect(project([...events, update]).steps[0]).toMatchObject({
      issue: STEP_ISSUE_UPDATE.issue, zone: sharpenedZone, state: 'finished',
    });
  });

  it('preserves a real OUTCOME without overriding closure precedence', () => {
    const update = stepEvent('step.updated', 3, { update: STEP_ISSUE_UPDATE });
    const result = project([...bound(), update, closureStep()]);
    expect(result.steps[0]).toMatchObject({
      issue: STEP_ISSUE_UPDATE.issue, zone: 'past', openExitConditions: ['released', 'prod'],
    });
  });

  it('ignores a malformed OUTCOME update without replacing a valid ref-only binding', () => {
    const invalid = stepEvent('step.updated', 3, { update: { issue: {
      ref: 'other/repo#1', outcome: 'OUTCOMES do not match the required word boundary',
    } } });
    const result = project([...bound(), invalid]);
    expect(result.steps[0]).toMatchObject({
      issue: { ref: STEP_ISSUE }, zone: 'tail', openExitConditions: ['closed', 'released', 'prod'],
    });
    expect(result.steps[0].issue).not.toHaveProperty('outcome');
  });
});
