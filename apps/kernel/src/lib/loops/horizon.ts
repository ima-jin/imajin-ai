import type { LoopEventJson } from './serialize';
import {
  isStepEventType, validateStepPayload, type StepAttestation, type StepClaim,
  type StepDeclaration, type StepEvidence, type StepExitCondition, type StepUpdate,
} from './step-types';

export type StepZone = 'tail' | 'middle' | 'near' | 'head' | 'past' | 'done';
export type StepState = 'queued' | 'claimed' | 'running' | 'blocked' | 'finished' | 'exited';
interface ConditionEvidence {
  eventId: string;
  issuer: string;
  at: string;
  fact: StepEvidence | StepAttestation;
}
export type HorizonStep = StepDeclaration & StepUpdate & {
  stepId: string;
  state: StepState;
  zone: StepZone;
  claim?: StepClaim;
  conditions: Array<{ declaration: StepExitCondition; satisfied: boolean; evidence: ConditionEvidence | null }>;
  openExitConditions: string[];
};
export interface Horizon {
  steps: HorizonStep[];
  depth: number;
  targetDepth: 12;
}
interface ReplayStep {
  stepId: string;
  declaration: StepDeclaration;
  update: StepUpdate;
  state: StepState;
  claim?: StepClaim;
  evidence: Map<string, ConditionEvidence>;
}

/** Smaller rank is closer to the head. History remains immutable, including done steps. */
export function projectHorizon(events: LoopEventJson[], loopId: string, principal: string, now = Date.now(), includeExited = false): Horizon {
  const steps = new Map<string, ReplayStep>();
  const ordered = events.filter(event => event.loopId === loopId && event.principal === principal)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
  for (const event of ordered) replayEvent(steps, event);
  const projected = [...steps.values()].map(step => projectStep(step, now));
  const visible = projected.filter(step => includeExited || step.zone !== 'done')
    .sort((a, b) => a.rank - b.rank || a.stepId.localeCompare(b.stepId));
  const depth = projected.filter(step => step.zone !== 'done').length;
  return { steps: visible, depth, targetDepth: 12 };
}

const lifecycle = {
  'step.started': 'running', 'step.progress': 'running', 'step.blocked': 'blocked', 'step.finished': 'finished',
} as const;

function replayEvent(steps: Map<string, ReplayStep>, event: LoopEventJson): void {
  if (!isStepEventType(event.type) || !validateStepPayload(event.type, event.payload, event.issuer)) return;
  const stepId = event.payload.stepId as string;
  if (event.type === 'step.queued') {
    // The earliest declaration wins: a later queue cannot erase exit criteria.
    if (!steps.has(stepId)) steps.set(stepId, {
      stepId, declaration: event.payload.step as StepDeclaration,
      update: {}, state: 'queued', evidence: new Map(),
    });
    return;
  }
  const step = steps.get(stepId);
  if (!step) return;
  if (event.type === 'step.updated') {
    step.update = { ...step.update, ...event.payload.update as StepUpdate };
  } else if (event.type === 'step.claimed') {
    step.claim = event.payload.claim as StepClaim;
    step.state = 'claimed';
  } else if (event.type === 'step.observed' || event.type === 'step.attested') {
    rememberEvidence(step, event);
  } else {
    step.state = lifecycle[event.type];
  }
}

function rememberEvidence(step: ReplayStep, event: LoopEventJson): void {
  const observation = event.payload.observation as { conditionId: string; evidence: StepEvidence } | undefined;
  const attestation = event.payload.attestation as StepAttestation | undefined;
  const conditionId = observation?.conditionId ?? attestation?.conditionId;
  const declared = step.declaration.exitConditions.find(condition => condition.id === conditionId);
  const fact = observation?.evidence ?? attestation;
  if (!declared || !fact) return;
  if (declared.kind === 'attestation') {
    if (!attestation || declared.attestorDid !== event.issuer) return;
  } else if (!observation || declared.kind !== observation.evidence.kind) {
    return;
  }
  step.evidence.set(declared.id, { eventId: event.id, issuer: event.issuer, at: event.occurredAt, fact });
}

function conditionSatisfied(step: ReplayStep, condition: StepExitCondition): boolean {
  const fact = step.evidence.get(condition.id)?.fact;
  if (!fact) return false;
  if (condition.kind === 'attestation') return 'did' in fact && fact.did === condition.attestorDid;
  if (!('kind' in fact) || fact.kind !== condition.kind) return false;
  if (fact.kind === 'issue_closed') return fact.issue === step.update.issue?.ref;
  if (fact.repository !== step.declaration.repository) return false;
  if (fact.kind === 'release_contains') return fact.issue === step.update.issue?.ref;
  const releaseCondition = step.declaration.exitConditions.find(item => item.kind === 'release_contains');
  const release = releaseCondition && step.evidence.get(releaseCondition.id)?.fact;
  return !!release && 'kind' in release && release.kind === 'release_contains'
    && release.issue === step.update.issue?.ref
    && release.repository === fact.repository && release.tag === fact.tag;
}

function projectStep(step: ReplayStep, now: number): HorizonStep {
  const conditions = step.declaration.exitConditions.map(declaration => ({
    declaration, satisfied: conditionSatisfied(step, declaration), evidence: step.evidence.get(declaration.id) ?? null,
  }));
  const openExitConditions = conditions.filter(condition => !condition.satisfied).map(condition => condition.declaration.id);
  const zone = deriveZone(step, conditions, now);
  return {
    ...step.declaration, ...step.update, stepId: step.stepId,
    state: zone === 'done' ? 'exited' : step.state, zone,
    ...(step.claim ? { claim: step.claim } : {}), conditions, openExitConditions,
  };
}

function deriveZone(step: ReplayStep, conditions: HorizonStep['conditions'], now: number): StepZone {
  if (conditions.every(condition => condition.satisfied)) return 'done';
  if (conditions.some(condition => condition.declaration.kind === 'issue_closed' && condition.satisfied)) return 'past';
  if (step.claim && Date.parse(step.claim.expiresAt) > now) return 'head';
  const { issue, briefRef, provisionRef, designRef } = step.update;
  if (issue && briefRef && provisionRef && designRef) return 'near';
  if (issue) return 'middle';
  return 'tail';
}
