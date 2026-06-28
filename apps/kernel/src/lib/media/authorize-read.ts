import type { FairManifest } from '@imajin/fair';
import { canReadAsset, type ReadDecision } from './read-access';

/**
 * Async per-asset READ authorization (#1166, closes #1168).
 *
 * Wraps the pure canReadAsset decision and adds conversation-membership gating
 * for non-owners, using the canonical chat access check (checkAccess from
 * @/src/lib/kernel/access — DM participation incl. the re-derivable dmDid hash,
 * group membership via chat.conversation_members, pods, events). This is the
 * function the HTTP media routes and the MCP media tools call.
 *
 * checkAccess is dependency-injectable (and otherwise lazily imported) so this
 * module can be unit-tested without standing up a DB client.
 */

export interface AuthorizeSubject {
  ownerDid: string;
  access: FairManifest['access'];
  /** asset.metadata — used to resolve the conversation DID when access lacks it. */
  metadata?: unknown;
}

type CheckAccessFn = (requesterDid: string, targetDid: string) => Promise<{ allowed: boolean }>;

export interface AuthorizeDeps {
  checkAccess?: CheckAccessFn;
}

/**
 * Resolve the conversation DID an asset belongs to, if determinable.
 * Prefers the manifest's FairAccess.conversationDid; falls back to the chat
 * upload convention (metadata.context.entityId) only when it is a conversation DID.
 */
function conversationDidFrom(subject: AuthorizeSubject): string | null {
  const { access } = subject;
  if (access && typeof access !== 'string' && access.conversationDid) {
    return access.conversationDid;
  }
  const ctx = (subject.metadata as { context?: { entityId?: unknown } } | null | undefined)?.context;
  const entityId = ctx?.entityId;
  if (
    typeof entityId === 'string' &&
    (entityId.startsWith('did:imajin:dm:') || entityId.startsWith('did:imajin:group:'))
  ) {
    return entityId;
  }
  return null;
}

export async function authorizeAssetRead(
  subject: AuthorizeSubject,
  requesterDid: string | null,
  deps: AuthorizeDeps = {},
): Promise<ReadDecision> {
  const base = canReadAsset({ ownerDid: subject.ownerDid, access: subject.access }, requesterDid);

  // Only conversation reads by an authenticated non-owner need the membership check.
  if (base.allowed || base.accessType !== 'conversation' || !requesterDid) {
    return base;
  }

  const conversationDid = conversationDidFrom(subject);
  if (!conversationDid) return base; // can't determine the conversation → stay denied

  const checkAccess = deps.checkAccess ?? (await import('@/src/lib/kernel/access')).checkAccess;
  const result = await checkAccess(requesterDid, conversationDid);
  return result.allowed
    ? { allowed: true, requiresAuth: true, accessType: 'conversation' }
    : base;
}
