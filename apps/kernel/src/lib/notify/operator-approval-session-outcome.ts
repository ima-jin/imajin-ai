import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { sessionAttestationSchema, sessionCommandFrameSchema, sessionOutcomeSchema } from '../jin/session-command-contract';
import type { SessionCommandFrame, SessionOutcome } from '../jin/session-command-contract';
import { getSessionEvent } from '../jin/session-command-store';

export interface ApprovalSessionOutcome {
  commandId: string;
  outcome: 'completed' | 'failed';
  at: string;
  reason?: string;
}

/** The result store accepts only verified socket attestations. Recheck this proposal's exact correlation. */
export async function readApprovalSessionOutcome(
  principal: string,
  approvalId: string,
  decision: string | undefined,
  rawCommand: unknown,
): Promise<ApprovalSessionOutcome | null> {
  const parsedCommand = sessionCommandFrameSchema.safeParse(rawCommand);
  if (!parsedCommand.success) return null;
  const command = parsedCommand.data;
  const expectedType = decision === 'approve' ? 'session.approve' : 'session.deny';
  if (!['approve', 'reject'].includes(decision ?? '') || command.type !== expectedType) return null;
  if (command.principal !== principal || command.payload.approvalId !== approvalId) return null;
  const outcome = await readCorrelatedOutcome(command, principal, approvalId);
  if (!outcome) return null;
  return {
    commandId: command.commandId, outcome: outcome.outcome, at: outcome.at,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

async function readCorrelatedOutcome(command: SessionCommandFrame, principal: string, approvalId: string): Promise<SessionOutcome | null> {
  const record = await getSessionEvent('result', command.commandId, principal);
  if (!record || record.issuer !== command.to || record.principal !== principal) return null;
  if (record.loop_id !== command.payload.loopId) return null;
  const attestation = sessionAttestationSchema.safeParse(record.payload.attestation);
  if (!attestation.success || attestation.data.from !== command.to) return null;
  const result = sessionOutcomeSchema.safeParse(attestation.data.payload);
  if (!result.success) return null;
  const outcome = result.data;
  const expected = {
    commandId: command.commandId, command: command.type, principal, approvalId,
    issuer: command.issuer, agentDid: command.to,
    eventType: `loop.${command.type}.${outcome.outcome}`,
    payloadHash: createHash('sha256').update(canonicalize(command.payload)).digest('hex'),
  };
  if (record.type !== expected.eventType) return null;
  if (!Object.entries(expected).every(([key, value]) => outcome[key as keyof typeof outcome] === value)) return null;
  return outcome;
}
