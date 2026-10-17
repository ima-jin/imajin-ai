import { createHash } from 'node:crypto';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import {
  sessionAttestationSchema, sessionBindingSchema, sessionOutcomeSchema,
  sessionCommandFrameSchema, type SessionAttestation, type SessionBinding, type SessionCommandFrame, type SessionOutcome,
} from './session-command-contract';
import { SessionCommandError, requireSessionAgent, resolveSessionCommandTarget } from './session-command-authority';
import { appendSessionEvent, getSessionEvent, persistSessionOutcome, readBindingEvents, readSessionLoopIdentity } from './session-command-store';

const MAX_INTAKE_BYTES = 24 * 1024;
const MAX_AGE = 5 * 60_000;
/** Durable execution-rail marker: invalid/stale bindings must NEVER restore legacy fan-out. */
export async function hasSessionBinding(principal: string, approvalId: string): Promise<boolean> {
  return (await readBindingEvents(principal, approvalId)).length > 0;
}
async function requireKnownOutcomeParent(outcome: SessionOutcome, command: SessionCommandFrame, loopId: string) {
  if (outcome.parentLoopId === undefined || command.type === 'session.spawn') return;
  const loop = await readSessionLoopIdentity(loopId, command.principal);
  if (!loop || (loop.parent_loop_id ?? null) !== outcome.parentLoopId) {
    throw new SessionCommandError('Outcome parent lineage mismatch', 403);
  }
}

async function verifyAttestation(attestation: SessionAttestation, agent: string, principal: string, fresh: boolean) {
  if (attestation.from !== agent) throw new SessionCommandError('Socket publisher mismatch', 403);
  const age = Date.now() - attestation.timestamp;
  if (fresh && (age > MAX_AGE || age < -60_000)) {
    throw new SessionCommandError('Attestation outside time window', 403);
  }
  const key = await requireSessionAgent(agent, principal);
  const { signature, ...signed } = attestation;
  if (!authCrypto.verifySync(signature, canonicalize(signed), key)) {
    throw new SessionCommandError('Invalid current agent signature', 403);
  }
}

/** Revalidates the stored original envelope and active owner, including current key rotation. */
export async function getSessionBinding(principal: string, approvalId: string, agentDid?: string): Promise<SessionBinding | null> {
  const rows = await readBindingEvents(principal, approvalId);
  if (rows.length !== 1) return null;
  try {
    const attestation = sessionAttestationSchema.parse(rows[0].payload.attestation);
    const binding = sessionBindingSchema.parse(attestation.payload);
    if (binding.principalDid !== principal || binding.approvalId !== approvalId) return null;
    if (agentDid && binding.agentDid !== agentDid) return null;
    await verifyAttestation(attestation, binding.agentDid, principal, false);
    const target = await resolveSessionCommandTarget(binding.loopId, principal);
    return target === binding.agentDid ? binding : null;
  } catch {
    return null;
  }
}

async function compareExistingBinding(
  original: unknown, attestation: SessionAttestation, binding: SessionBinding, key: string,
) {
  const old = sessionAttestationSchema.parse(original);
  if (canonicalize(old.payload) !== canonicalize(binding)) {
    await appendSessionEvent('binding-conflict', `${key}:${canonicalize(binding)}`, binding.loopId, 'loop.approval.bound',
      binding.agentDid, binding.principalDid, { attestation });
    throw new SessionCommandError('Conflicting approval binding', 409);
  }
  return { accepted: true, duplicate: true };
}

async function ingestBinding(socketDid: string, attestation: SessionAttestation) {
  const binding = sessionBindingSchema.parse(attestation.payload);
  await verifyAttestation(attestation, socketDid, binding.principalDid, true);
  if (binding.agentDid !== socketDid || await resolveSessionCommandTarget(binding.loopId, binding.principalDid) !== socketDid) {
    throw new SessionCommandError('Approval binding publisher mismatch', 403);
  }
  const key = canonicalize([binding.principalDid, binding.approvalId]);
  const existing = await getSessionEvent('binding', key, binding.principalDid);
  if (existing) return compareExistingBinding(existing.payload.attestation, attestation, binding, key);
  const inserted = await appendSessionEvent('binding', key, binding.loopId, 'loop.approval.bound',
    socketDid, binding.principalDid, { attestation });
  if (!inserted) {
    const raced = await getSessionEvent('binding', key, binding.principalDid);
    return compareExistingBinding(raced?.payload.attestation, attestation, binding, key);
  }
  return { accepted: true, duplicate: false };
}

function requireOutcomeCorrelation(type: string, outcome: SessionOutcome, command: SessionCommandFrame): void {
  const expectedType = `loop.${command.type}.${outcome.outcome}`;
  const hash = createHash('sha256').update(canonicalize(command.payload)).digest('hex');
  const matches = type === expectedType && outcome.eventType === type && outcome.command === command.type
    && outcome.principal === command.principal && outcome.issuer === command.issuer
    && outcome.agentDid === command.to && outcome.payloadHash === hash
    && outcome.approvalId === command.payload.approvalId;
  if (!matches) throw new SessionCommandError('Outcome is not correlated with signed command', 403);
  const at = Date.parse(outcome.at);
  if (at < Date.parse(command.issuedAt) - 60_000 || at > Date.now() + 60_000) {
    throw new SessionCommandError('Outcome time mismatch', 403);
  }
}

function requireOutcomeLineage(outcome: SessionOutcome, command: SessionCommandFrame, loopId: string): void {
  if (command.type === 'session.spawn' && outcome.outcome === 'completed') {
    if (!outcome.loopId || outcome.childLoopId !== outcome.loopId || outcome.parentLoopId !== loopId || outcome.loopId === loopId) {
      throw new SessionCommandError('Invalid attested spawn lineage', 403);
    }
    return;
  }
  if (outcome.childLoopId || (outcome.loopId !== undefined && outcome.loopId !== loopId)) {
    throw new SessionCommandError('Outcome target mismatch', 403);
  }
  if (outcome.outcome === 'completed' && outcome.loopId !== loopId) {
    throw new SessionCommandError('Completed command requires resolved run', 403);
  }
}

async function ingestOutcome(socketDid: string, type: string, attestation: SessionAttestation) {
  const outcome = sessionOutcomeSchema.parse(attestation.payload);
  await verifyAttestation(attestation, socketDid, outcome.principal, true);
  const stored = await getSessionEvent('command', outcome.commandId, outcome.principal);
  if (!stored) throw new SessionCommandError('Unknown command outcome', 404);
  const command = sessionCommandFrameSchema.parse(stored.payload.command);
  if (command.to !== socketDid) throw new SessionCommandError('Foreign command outcome', 403);
  requireOutcomeCorrelation(type, outcome, command);
  requireOutcomeLineage(outcome, command, stored.loop_id);
  await requireKnownOutcomeParent(outcome, command, stored.loop_id);
  if (!await getSessionEvent('attempt', outcome.commandId, outcome.principal)) {
    throw new SessionCommandError('Command has not been dispatched', 409);
  }
  const existing = await getSessionEvent('result', outcome.commandId, outcome.principal);
  if (existing) {
    const previous = sessionAttestationSchema.parse(existing.payload.attestation);
    if (canonicalize(previous.payload) !== canonicalize(outcome)) throw new SessionCommandError('Conflicting command result', 409);
    return { accepted: true, duplicate: true };
  }
  const inserted = await persistSessionOutcome(command, attestation, outcome, stored.loop_id);
  if (!inserted) throw new SessionCommandError('Concurrent result already recorded', 409);
  return { accepted: true, duplicate: false };
}

/** socketDid is supplied only by authenticated socket metadata through the internal route. */
export async function ingestSessionCommandFrame(socketDid: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Buffer.byteLength(JSON.stringify(raw)) > MAX_INTAKE_BYTES) {
    throw new SessionCommandError('Invalid or oversized session event', 400);
  }
  const { type, attestation: envelope, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length) throw new SessionCommandError('Unexpected session event fields');
  const attestation = sessionAttestationSchema.parse(envelope);
  if (type === 'loop.approval.bound') return ingestBinding(socketDid, attestation);
  if (typeof type !== 'string' || !/^loop\.session\.(send|abort|spawn|approve|deny)\.(completed|failed)$/.test(type)) {
    throw new SessionCommandError('Unsupported session event');
  }
  return ingestOutcome(socketDid, type, attestation);
}
