import { projectHorizon, type HorizonLease } from '@/src/lib/loops/horizon';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import type { StepEventType } from '@/src/lib/loops/step-types';

/** Development data goes through the same projection as registry reads, not hand-assigned UI zones. */
export function createHorizonFixture(loopId: string, principal: string, holderDid: string) {
  const events: LoopEventJson[] = [];
  const leases: HorizonLease[] = [];
  const at = new Date().toISOString();
  function event(stepId: string, type: StepEventType, fields: Record<string, unknown>) {
    events.push({
      id: `horizon-${events.length.toString().padStart(4, '0')}`, loopId, principal, issuer: holderDid,
      type, occurredAt: at, createdAt: at, payload: { stepId, state: 'queued', ...fields },
    });
  }
  function lease(stepId: string) {
    leases.push({ surface: `step:${stepId}`, loopId, principal, holderDid,
      acquiredAt: new Date(Date.now() - 7 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
  }
  for (let index = 0; index < 12; index++) {
    const stepId = `fixture-step-${index + 1}`;
    const issue = `ima-jin/imajin-ai#${2880 + index}`;
    event(stepId, 'step.queued', { step: {
      stepKind: 'code', intention: `Intention ${index + 1} · keep the loop moving`, rank: index,
      repository: 'ima-jin/imajin-ai',
      exitConditions: [{ id: 'closed', kind: 'issue_closed' }, { id: 'release', kind: 'release_contains' }, { id: 'prod', kind: 'deployed' }],
    } });
    if (index < 8 || index > 9) event(stepId, 'step.updated', {
      update: { issue: { ref: issue, outcome: `OUTCOME · Step ${index + 1} survives agent restarts` } },
    });
    if (index < 5) event(stepId, 'step.updated', {
      update: { briefRef: 'brief:fixture', provisionRef: 'provision:fixture', designRef: 'design:fixture' },
    });
    if (index < 2) lease(stepId);
    if (index > 9) event(stepId, 'step.observed', {
      observation: { conditionId: 'closed', evidence: { kind: 'issue_closed', issue } },
    });
    if (index === 11) event(stepId, 'step.observed', {
      observation: { conditionId: 'release', evidence: { kind: 'release_contains', repository: 'ima-jin/imajin-ai',
        issue, mergeCommit: 'a'.repeat(40), tag: 'v0.9.1' } },
    });
  }
  return {
    read: () => projectHorizon(events, loopId, principal, Date.now(), false, leases),
    observeClaim: (message: string) => {
      // Only the delayed fixture-agent observation changes the read model.
      const step = projectHorizon(events, loopId, principal, Date.now(), false, leases).steps.find(item =>
        item.zone === 'near' && message.startsWith(`Claim horizon step ${JSON.stringify(item.stepId)} in loop ${JSON.stringify(loopId)}.`));
      if (step) lease(step.stepId);
    },
  };
}
