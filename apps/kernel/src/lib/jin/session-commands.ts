import { randomUUID } from 'node:crypto';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { db } from '@/src/db';
import { getNodeDidFromConfig } from '@/src/lib/kernel/node-identity';
import {
  parseSessionCommandPayload, sessionCommandBody, sessionCommandFrameSchema,
  type SessionCommandFrame, type SessionCommandType,
} from './session-command-contract';
import { SessionCommandError, currentIdentityPublicKey, resolveSessionCommandTarget } from './session-command-authority';
import { appendSessionEvent, getSessionEvent, insertSessionCommand } from './session-command-store';
import { getSessionBinding } from './session-command-intake';

export { SessionCommandError } from './session-command-authority';
export { insertSessionCommand } from './session-command-store';
export { getSessionBinding, hasSessionBinding } from './session-command-intake';

const TTL = 5 * 60_000;
const SKEW = 60_000;
interface ApprovalContext { approvalId?: string }
async function commandIssuer(): Promise<string> {
  const did = await getNodeDidFromConfig();
  if (!did.startsWith('did:') || did.length > 512) throw new SessionCommandError('Command issuer unavailable', 503);
  return did;
}

function signingKey(): string {
  const key = process.env.AUTH_PRIVATE_KEY;
  if (!key) throw new SessionCommandError('Command signing unavailable', 503);
  return key;
}

function requireTargetPayload(loopId: string, type: SessionCommandType, payload: Record<string, string>): void {
  const target = type === 'session.spawn' ? payload.parentLoopId : payload.loopId;
  if (target !== loopId) throw new SessionCommandError('Command must address this run');
}

async function requireApprovalBinding(
  loopId: string, principal: string, agentDid: string, payload: Record<string, string>,
): Promise<void> {
  if (!payload.approvalId) return;
  const binding = await getSessionBinding(principal, payload.approvalId, agentDid);
  if (binding?.loopId !== loopId) throw new SessionCommandError('Verified approval binding required', 409);
}

export async function prepareSessionCommand(
  loopId: string, principal: string, type: SessionCommandType, rawPayload: unknown,
): Promise<SessionCommandFrame> {
  const payload = parseSessionCommandPayload(type, rawPayload);
  requireTargetPayload(loopId, type, payload);
  const agentDid = await resolveSessionCommandTarget(loopId, principal);
  await requireApprovalBinding(loopId, principal, agentDid, payload);
  const now = Date.now();
  const body = {
    type, commandId: randomUUID(), to: agentDid, principal, issuer: await commandIssuer(),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL).toISOString(), payload,
  };
  const key = signingKey();
  return {
    ...body,
    signature: { keyId: authCrypto.getPublicKey(key), alg: 'ed25519', sig: authCrypto.signSync(canonicalize(body), key) },
  };
}

function requireCommandTime(frame: SessionCommandFrame): void {
  const issued = Date.parse(frame.issuedAt);
  const expires = Date.parse(frame.expiresAt);
  if (expires <= issued || expires - issued > TTL || issued > Date.now() + SKEW || expires <= Date.now()) {
    throw new SessionCommandError('Command expired or outside time window', 403);
  }
}

function requireApprovalRail(frame: SessionCommandFrame, context: ApprovalContext): void {
  const approvalId = frame.payload.approvalId;
  const approvalVerb = ['session.approve', 'session.deny'].includes(frame.type);
  if ((approvalId || approvalVerb) && (!context.approvalId || context.approvalId !== approvalId)) {
    throw new SessionCommandError('Approval commands require the approval decision endpoint', 403);
  }
  if (context.approvalId && context.approvalId !== approvalId) {
    throw new SessionCommandError('Command approval association mismatch', 403);
  }
}

/** Re-read every authority/key at dispatch; prepare grants are not durable authority. */
export async function verifySessionCommand(
  loopId: string, principal: string, raw: unknown, context: ApprovalContext = {},
): Promise<SessionCommandFrame> {
  const frame = sessionCommandFrameSchema.parse(raw);
  parseSessionCommandPayload(frame.type, frame.payload);
  requireTargetPayload(loopId, frame.type, frame.payload);
  requireApprovalRail(frame, context);
  requireCommandTime(frame);
  const target = await resolveSessionCommandTarget(loopId, principal);
  if (frame.principal !== principal || frame.to !== target || frame.issuer !== await commandIssuer()) {
    throw new SessionCommandError('Command identity mismatch', 403);
  }
  const canonical = canonicalize(sessionCommandBody(frame));
  const kernelKey = authCrypto.getPublicKey(signingKey());
  if (frame.signature.keyId !== kernelKey || !authCrypto.verifySync(frame.signature.sig, canonical, kernelKey)) {
    throw new SessionCommandError('Invalid kernel grant', 403);
  }
  const principalKey = await currentIdentityPublicKey(principal);
  const wish = frame.countersignature;
  if (wish?.keyId !== principalKey || !authCrypto.verifySync(wish.sig, canonical, principalKey)) {
    throw new SessionCommandError('Invalid full principal wish signature', 403);
  }
  await requireApprovalBinding(loopId, principal, target, frame.payload);
  return frame;
}

async function pushOwnAgent(frame: SessionCommandFrame): Promise<boolean> {
  const internalKey = process.env.AUTH_INTERNAL_API_KEY;
  if (!internalKey) return false;
  try {
    const port = process.env.WS_PORT || process.env.PORT || '3000';
    const response = await fetch(`http://localhost:${port}/chat/api/internal/session-command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey },
      body: JSON.stringify({ targetDid: frame.to, command: frame }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    return (await response.json()).delivered === true;
  } catch {
    return false;
  }
}

/** Single durable attempt, including when the transport response is lost. Never resends a claimed command. */
export async function deliverSessionCommand(loopId: string, frame: SessionCommandFrame) {
  const stored = await getSessionEvent('command', frame.commandId, frame.principal);
  if (stored?.loop_id !== loopId || canonicalize(stored.payload.command) !== canonicalize(frame)) {
    throw new SessionCommandError('Command was not durably queued', 409);
  }
  await verifySessionCommand(loopId, frame.principal, frame, { approvalId: frame.payload.approvalId });
  const claimed = await appendSessionEvent('attempt', frame.commandId, loopId, 'loop.command.dispatching',
    frame.issuer, frame.principal, { commandId: frame.commandId });
  if (!claimed) {
    const receipt = await getSessionEvent('transport', frame.commandId, frame.principal);
    return { commandId: frame.commandId, delivered: receipt?.payload.delivered === true };
  }
  const delivered = await pushOwnAgent(frame);
  await appendSessionEvent('transport', frame.commandId, loopId, 'loop.command.transport',
    frame.issuer, frame.principal, { commandId: frame.commandId, delivered });
  return { commandId: frame.commandId, delivered };
}

export async function dispatchSessionCommand(loopId: string, principal: string, command: unknown) {
  const frame = await verifySessionCommand(loopId, principal, command);
  const inserted = await insertSessionCommand(db, loopId, frame);
  if (!inserted) throw new SessionCommandError('Command ID already consumed', 409);
  return deliverSessionCommand(loopId, frame);
}
