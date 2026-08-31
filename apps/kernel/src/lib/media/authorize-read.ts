import type { FairManifest } from '@imajin/fair';
import { canReadAsset, type ReadDecision } from './read-access';

/**
 * Async per-asset READ authorization (#1166, closes #1168, closes #1851).
 *
 * Wraps the pure canReadAsset decision and adds two DB-backed fallbacks for
 * non-owners:
 *   - conversation-membership gating, using the canonical chat access check
 *     (checkAccess from @/src/lib/kernel/access — DM participation incl. the
 *     re-derivable dmDid hash, group membership via chat.conversation_members,
 *     pods, events).
 *   - group/business-scope identity_members membership (#1851): a private
 *     asset owned by an org/community/family identity is readable by that
 *     identity's own members, matching the delegated WRITE path (which
 *     already authorizes via identity_members for X-Acting-For).
 * This is the function the HTTP media routes and the MCP media tools call.
 *
 * Both fallbacks are dependency-injectable (and otherwise lazily imported) so
 * this module can be unit-tested without standing up a DB client.
 */

export interface AuthorizeSubject {
  ownerDid: string;
  access: FairManifest['access'];
  /** asset.metadata — used to resolve the conversation DID when access lacks it. */
  metadata?: unknown;
}

type CheckAccessFn = (requesterDid: string, targetDid: string) => Promise<{ allowed: boolean }>;
type IsGroupMemberFn = (ownerDid: string, requesterDid: string) => Promise<boolean>;

export interface AuthorizeDeps {
  checkAccess?: CheckAccessFn;
  isGroupMember?: IsGroupMemberFn;
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

  // Already allowed, or no authenticated requester to re-check against.
  if (base.allowed || !requesterDid) {
    return base;
  }

  // Private (#1851): fall back to identity_members when the owner is a
  // group/business-scope identity — mirrors the delegated WRITE path, which
  // already treats org membership as authorization.
  if (base.accessType === 'private') {
    const isGroupMember = deps.isGroupMember ?? (await import('@/src/lib/auth/group-membership')).isActiveGroupMember;
    const allowed = await isGroupMember(subject.ownerDid, requesterDid);
    return allowed ? { allowed: true, requiresAuth: true, accessType: 'private' } : base;
  }

  if (base.accessType !== 'conversation') {
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
