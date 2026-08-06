/**
 * Canonical DM conversation resolution and consent gate (#1649, #855).
 *
 * Two guards on the one path that can create a direct-message thread:
 *
 *  1. Uniqueness (#1649) — a DM thread is keyed by `dmDid(a, b)`, the sorted
 *     SHA-256 of the participant pair. Callers that pass a raw person DID as
 *     the conversation key used to get a brand-new thread beside the canonical
 *     one. Such keys are rewritten to the canonical `dmDid()` value.
 *
 *  2. Consent (#855) — creating a NEW thread requires an active connection
 *     with the counterparty (agents excepted). An existing thread is never
 *     re-keyed and never re-gated: the pair already talks.
 *
 * The counterparty can only be gated when it is knowable: either the caller
 * passed a raw person DID as the conversation key, or it supplied
 * `recipientDid`. A bare `did:imajin:dm:<hash>` is one-way, so it cannot be
 * inverted here — those callers are gated at the point where they name the
 * target (see app/chat/start/route.ts).
 */
import { eq } from 'drizzle-orm';
import { db, conversationsV2, identities } from '@/src/db';
import { dmDid, parseConversationDid } from './conversation-did';
import { canInitiateDm, DM_CONNECTION_REQUIRED } from './connection-check';

export interface DmTargetInput {
  /** The conversation DID as supplied by the caller (may be non-canonical). */
  conversationDid: string;
  senderDid: string;
  /** The other party, when the caller knows it. */
  recipientDid?: string | null;
}

export type DmTargetResult =
  | { ok: true; conversationDid: string; exists: boolean }
  | { ok: false; status: number; error: string };

interface DmResolution {
  conversationDid: string;
  counterparty: string | null;
  exists: boolean;
}

async function conversationExists(did: string): Promise<boolean> {
  const row = await db.query.conversationsV2.findFirst({
    where: eq(conversationsV2.did, did),
  });
  return !!row;
}

/**
 * True when `did` names a person or agent rather than a forest, group or
 * event. Only actor DIDs are rewritten into DM keys — event conversations
 * legitimately use an identity DID as their conversation DID.
 */
async function isActorDid(did: string): Promise<boolean> {
  try {
    const identity = await db.query.identities.findFirst({ where: eq(identities.id, did) });
    return identity?.scope === 'actor';
  } catch { return false; }
}

/**
 * Work out who the DM is with, or null when this is not a resolvable DM.
 *
 * Cognitive complexity: 5 (≤ 15)
 */
async function findCounterparty(
  conversationDid: string,
  senderDid: string,
  recipientDid: string | null,
): Promise<string | null> {
  const parsed = parseConversationDid(conversationDid);

  if (parsed.type === 'dm') {
    const named = recipientDid && recipientDid !== senderDid;
    return named ? recipientDid : null;
  }

  // A raw person DID used as a conversation key — the duplicate-thread bug.
  if (parsed.type === 'identity' && conversationDid !== senderDid) {
    const actor = await isActorDid(conversationDid);
    return actor ? conversationDid : null;
  }

  return null;
}

/**
 * Cognitive complexity: 4 (≤ 15)
 */
async function resolveDm(input: DmTargetInput): Promise<DmResolution> {
  const { conversationDid, senderDid } = input;
  const recipientDid = input.recipientDid ?? null;

  // An existing thread wins outright — never re-key, never re-gate.
  if (await conversationExists(conversationDid)) {
    return { conversationDid, counterparty: null, exists: true };
  }

  const counterparty = await findCounterparty(conversationDid, senderDid, recipientDid);
  if (!counterparty) {
    return { conversationDid, counterparty: null, exists: false };
  }

  const canonical = dmDid(senderDid, counterparty);
  if (canonical === conversationDid) {
    return { conversationDid, counterparty, exists: false };
  }

  return { conversationDid: canonical, counterparty, exists: await conversationExists(canonical) };
}

/**
 * Canonical conversation DID for a send, without the consent gate. Used by
 * `ensureConversation()` as a net for callers that never named a recipient.
 */
export async function canonicalDmConversationDid(
  conversationDid: string,
  senderDid: string,
  recipientDid: string | null = null,
): Promise<string> {
  const resolved = await resolveDm({ conversationDid, senderDid, recipientDid });
  return resolved.conversationDid;
}

/**
 * Resolve the conversation DID a send should land on, refusing the send when
 * it would open a new DM thread with someone the sender is not connected to.
 *
 * Cognitive complexity: 3 (≤ 15)
 */
export async function resolveDmConversationTarget(input: DmTargetInput): Promise<DmTargetResult> {
  const resolved = await resolveDm(input);

  if (resolved.exists || !resolved.counterparty) {
    return { ok: true, conversationDid: resolved.conversationDid, exists: resolved.exists };
  }

  if (await canInitiateDm(input.senderDid, resolved.counterparty)) {
    return { ok: true, conversationDid: resolved.conversationDid, exists: false };
  }

  return { ok: false, status: 403, error: DM_CONNECTION_REQUIRED };
}
