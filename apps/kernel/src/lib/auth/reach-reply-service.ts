import { crypto as authCrypto, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE, type Identity } from '@imajin/auth';
import { createDbResolver } from '@imajin/auth/resolve-db';
import { publish } from '@imajin/bus';
import { db, identities } from '@/src/db';
import { getReachEnvelope } from './reach-envelope-store';
import { markReachReplyPublished, persistReachReply } from './reach-reply-store';
import { canonicalReachReply, reachReplyEvent, type ReachReplySignature, type SignedReachReplyEvent } from './reach-reply-wire';

export interface ReachReplyInput {
  message: string;
  issuedAt: string;
  signature: ReachReplySignature;
}

export type ReachReplyResult =
  | { ok: true; reply: SignedReachReplyEvent }
  | { ok: false; status: number; error: string };

export function isReachPrincipal(identity: Identity): boolean {
  return identity.scope === 'actor' && identity.subtype === 'human'
    && !identity.actingAs && !identity.actingFor;
}

/** Required, bounded, and deliberately no optional-signature compatibility path. */
export function parseReachReplyInput(raw: unknown): ReachReplyInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 16_000) return null;
  if (typeof body.issuedAt !== 'string') return null;
  if (!body.signature || typeof body.signature !== 'object') return null;
  const signature = body.signature as Record<string, unknown>;
  if (signature.alg !== 'ed25519') return null;
  if (typeof signature.keyId !== 'string' || !/^[0-9a-f]{64}$/i.test(signature.keyId)) return null;
  if (typeof signature.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(signature.sig)) return null;
  return {
    message: body.message, issuedAt: body.issuedAt,
    signature: { alg: 'ed25519', keyId: signature.keyId.toLowerCase(), sig: signature.sig.toLowerCase() },
  };
}

function fresh(issuedAt: string): boolean {
  const timestamp = Date.parse(issuedAt);
  const age = Date.now() - timestamp;
  return Number.isFinite(timestamp) && age <= SIGNED_MESSAGE_MAX_AGE && age >= -FUTURE_TOLERANCE;
}

async function signatureValid(principalDid: string, reply: SignedReachReplyEvent): Promise<boolean> {
  const resolved = await createDbResolver(db, identities)(principalDid);
  const { signature, ...payload } = reply.payload;
  if (!resolved?.publicKey || resolved.publicKey.toLowerCase() !== signature.keyId) return false;
  return authCrypto.verifySync(signature.sig, canonicalReachReply({ ...reply, payload }), resolved.publicKey);
}

/** Direct human session only; commits first, publishes original bytes, then acks. */
export async function replyToReach(params: {
  identity: Identity;
  reachId: string;
  input: ReachReplyInput;
}): Promise<ReachReplyResult> {
  if (!isReachPrincipal(params.identity)) return { ok: false, status: 403, error: 'A direct human session is required' };
  const input = parseReachReplyInput(params.input);
  if (!input) return { ok: false, status: 400, error: 'A message, issuedAt and Ed25519 signature are required' };
  const principalDid = params.identity.id;
  const envelope = await getReachEnvelope({ principalDid, reachId: params.reachId });
  if (!envelope) return { ok: false, status: 404, error: 'Reach envelope not found' };
  const event = reachReplyEvent(envelope, input.message, input.issuedAt);
  const reply: SignedReachReplyEvent = { ...event, payload: { ...event.payload, signature: input.signature } };
  if (!await signatureValid(principalDid, reply)) return { ok: false, status: 401, error: 'Invalid principal signature' };
  // Exact stored retries remain recoverable after the freshness window; no
  // stale request can create or replace a reply.
  const retry = envelope.reply && canonicalReachReply(envelope.reply) === canonicalReachReply(reply);
  if (!retry && !fresh(input.issuedAt)) return { ok: false, status: 401, error: 'Invalid principal signature' };
  const result = await persistReachReply({ principalDid, reachId: params.reachId, reply });
  if (!result.ok) return result;
  if (!result.published) {
    // Bus reactors may annotate payloads; never let that mutate signed state.
    await publish('agent.reach.replied', {
      ...result.reply,
      payload: { ...result.reply.payload, signature: { ...result.reply.payload.signature } },
    });
    await markReachReplyPublished({ principalDid, reachId: params.reachId });
  }
  return { ok: true, reply: result.reply };
}
