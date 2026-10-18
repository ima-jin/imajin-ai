import type { LoopEventJson } from '../serialize';
import type { StepDeclaration, StepEventType } from '../step-types';

export const STEP_PRINCIPAL = 'did:imajin:owner';
export const STEP_REPOSITORY = 'ima-jin/imajin-ai';
export const STEP_ISSUE = 'https://github.com/ima-jin/imajin-ai/issues/2878';
export const STEP_NOW = Date.parse('2026-10-17T12:00:00Z');
export const CODE_STEP: StepDeclaration = {
  stepKind: 'code', intention: 'Make the horizon durable', rank: 10, repository: STEP_REPOSITORY,
  exitConditions: [
    { id: 'closed', kind: 'issue_closed' },
    { id: 'released', kind: 'release_contains' },
    { id: 'prod', kind: 'deployed' },
  ],
};
export const STEP_ISSUE_UPDATE = { issue: { ref: STEP_ISSUE, outcome: 'OUTCOME · The horizon survives restarts' } };
export const STEP_READY = { briefRef: 'brief:2878', provisionRef: 'provision:2878', designRef: 'decision:2313:a' };
export const STEP_CLAIM = { leaseId: 'lease:2878', holderDid: STEP_PRINCIPAL, expiresAt: '2026-10-18T12:00:00Z' };
export function stepEvent(
  type: StepEventType, sequence: number, fields: Record<string, unknown> = {}, stepId = 'step-2878',
): LoopEventJson {
  const at = new Date(STEP_NOW - 100_000 + sequence * 1000).toISOString();
  return {
    id: `event-${sequence.toString().padStart(4, '0')}`, type, issuer: STEP_PRINCIPAL,
    loopId: 'cycle', principal: STEP_PRINCIPAL, occurredAt: at, createdAt: at,
    payload: { loopId: 'cycle', principal: STEP_PRINCIPAL, kind: 'cycle', state: 'queued', summary: type, at, stepId, ...fields },
  };
}
export const queuedStep = () => stepEvent('step.queued', 0, { step: structuredClone(CODE_STEP) });
export function observedStep(sequence: number, conditionId: string, evidence: Record<string, unknown>): LoopEventJson {
  return stepEvent('step.observed', sequence, { observation: { conditionId, evidence } });
}
export const closureStep = () => observedStep(6, 'closed', { kind: 'issue_closed', issue: STEP_ISSUE });
export const releaseStep = () => observedStep(7, 'released', {
  kind: 'release_contains', repository: STEP_REPOSITORY, issue: STEP_ISSUE, mergeCommit: 'a'.repeat(40), tag: 'v1.0.0',
});
export const deployedStep = () => observedStep(8, 'prod', {
  kind: 'deployed', repository: STEP_REPOSITORY, tag: 'v1.0.0', environment: 'prod',
});
