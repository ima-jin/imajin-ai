import { NextRequest, NextResponse } from 'next/server';
import { db, identities, identityMembers, attestations, agentKnocks } from '@/src/db';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { requireAuth, authErrorResponse, generateKeypair, resolveActingDid } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { listGrantDetailsForDelegator, type DelegationGrantDetail } from '@/src/lib/auth/grants';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const HANDLE_REGEX = /^[a-z0-9_-]+$/;

interface AgentResponse {
  did: string;
  handle: string | null;
  displayName: string | null;
  name: string | null;
  createdAt: string | null;
  tier: string;
  status: 'online' | 'offline';
  role: string;
  /** True once #1887's grants-view has at least one grant on record for this agent. */
  isExternal: boolean;
  /** Bring-your-own DID recorded as an attestation at knock-accept time (#1883), if any. */
  externalDid: string | null;
  /** Grants-view read surface (#1887): every grant this caller has issued to this agent. */
  grants: DelegationGrantDetail[];
  /**
   * True when this agent still has an active role='agent' identity_members
   * row on the caller's identity — i.e. it may still be authorized via the
   * #1887 dual-read membership fallback rather than a grant. Surfaced so
   * the UI can nudge "issue a scoped grant to replace this".
   */
  hasLegacyMembership: boolean;
}

/**
 * GET /auth/api/agents
 *
 * #1887: re-renders as a grants view. "One list, all agents": local agents
 * (owned via the legacy identity_members owner/agent bootstrap) and external
 * agents (connected via #1883's knock+accept, never owned via membership) are
 * merged into a single list, distinguished by the external-identity
 * attestation from #1883 rather than by type. Every agent's grants (issued,
 * revoked, expired — the honest record) are embedded per the grants-view
 * read-surface spec.
 *
 * #1894: a third union source. #1883's `acceptKnock()` deliberately mints an
 * identity and a `connections` linkage with ZERO grants ("accept must never
 * be optimized into accept+grant") — such an agent matches neither the
 * owned-membership source nor the grants-derived source above and would
 * otherwise never appear here, leaving no UI path to issue its first grant.
 * READ-PATH VISIBILITY ONLY: appearing in this list implies no authority —
 * the grant-issuance authorization path (POST /auth/api/grants, #1882) is
 * untouched by this source.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  // Resolve the acting DID (#1717): when the caller is operating on behalf of
  // a business/app DID (X-Acting-For), agents they create/list belong to that
  // acting DID, not to the caller's raw personal session DID.
  const actingDid = resolveActingDid(authResult.identity);

  try {
    const ownedRows = await db
      .select({
        did: identities.id,
        handle: identities.handle,
        name: identities.name,
        createdAt: identities.createdAt,
        tier: identities.tier,
        role: identityMembers.role,
      })
      .from(identityMembers)
      .innerJoin(identities, eq(identityMembers.identityDid, identities.id))
      .where(
        and(
          eq(identityMembers.memberDid, actingDid),
          isNull(identityMembers.removedAt),
          eq(identities.subtype, 'agent'),
          eq(identities.scope, 'actor')
        )
      )
      .orderBy(identities.createdAt);

    const grantDetails = await listGrantDetailsForDelegator(actingDid);
    const grantsByAgent = new Map<string, DelegationGrantDetail[]>();
    for (const grant of grantDetails) {
      const list = grantsByAgent.get(grant.agentDid) ?? [];
      list.push(grant);
      grantsByAgent.set(grant.agentDid, list);
    }

    // #1894: agents the acting DID has knock-accepted (#1883) but may hold
    // zero grants for. Sourced from `agent_knocks` rather than `connections`
    // since it's already indexed on (declared_target, status) for exactly
    // this lookup and carries the agent's DID directly.
    const acceptedKnockRows = await db
      .select({ agentDid: agentKnocks.agentDid })
      .from(agentKnocks)
      .where(and(eq(agentKnocks.declaredTarget, actingDid), eq(agentKnocks.status, 'accepted')));
    const knockAcceptedDids = new Set(acceptedKnockRows.map((row: { agentDid: string }) => row.agentDid));

    type OwnedRow = (typeof ownedRows)[number];
    const ownedDids = new Set(ownedRows.map((row: OwnedRow) => row.did));
    const externalOnlyDids = [...new Set([...grantsByAgent.keys(), ...knockAcceptedDids])].filter(
      (did) => !ownedDids.has(did),
    );

    const externalIdentityRows = externalOnlyDids.length === 0 ? [] : await db
      .select({
        did: identities.id,
        handle: identities.handle,
        name: identities.name,
        createdAt: identities.createdAt,
        tier: identities.tier,
      })
      .from(identities)
      .where(inArray(identities.id, externalOnlyDids));

    const allAgentDids = [...new Set([...ownedRows.map((row: OwnedRow) => row.did), ...externalOnlyDids])];

    // #1883: an agent that supplied a bring-your-own external DID at
    // knock-accept time gets it recorded as an attestation — the sibling-
    // topology signal the grants view uses to badge "external", never the
    // agent's own identity `subtype` (every agent, local or external, is
    // subtype='agent').
    const externalIdentityAttestations = allAgentDids.length === 0 ? [] : await db
      .select({ subjectDid: attestations.subjectDid, payload: attestations.payload })
      .from(attestations)
      .where(and(inArray(attestations.subjectDid, allAgentDids), eq(attestations.type, 'agent.external_identity')));
    const externalDidByAgent = new Map<string, string>();
    for (const row of externalIdentityAttestations) {
      const payload = row.payload as { external_did?: string } | null;
      if (payload?.external_did) externalDidByAgent.set(row.subjectDid, payload.external_did);
    }

    // Legacy dual-read fallback visibility (#1887): does this agent still
    // hold the coarse role='agent' membership on the caller's identity?
    const legacyMembershipRows = allAgentDids.length === 0 ? [] : await db
      .select({ memberDid: identityMembers.memberDid })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, actingDid),
          inArray(identityMembers.memberDid, allAgentDids),
          eq(identityMembers.role, 'agent'),
          isNull(identityMembers.removedAt),
        ),
      );
    const legacyMembershipDids = new Set(legacyMembershipRows.map((row: { memberDid: string }) => row.memberDid));

    type ExternalIdentityRow = (typeof externalIdentityRows)[number];

    const agents: AgentResponse[] = [
      ...ownedRows.map((row: OwnedRow) => ({
        did: row.did,
        handle: row.handle,
        displayName: row.name,
        name: row.name,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        tier: row.tier,
        status: 'offline' as const, // placeholder until real status tracking
        role: row.role,
        isExternal: externalDidByAgent.has(row.did),
        externalDid: externalDidByAgent.get(row.did) ?? null,
        grants: grantsByAgent.get(row.did) ?? [],
        hasLegacyMembership: legacyMembershipDids.has(row.did),
      })),
      ...externalIdentityRows.map((row: ExternalIdentityRow) => ({
        did: row.did,
        handle: row.handle,
        displayName: row.name,
        name: row.name,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        tier: row.tier,
        status: 'offline' as const,
        // No identity_members ownership row — present via a grant, or (#1894)
        // via a knock-accept with zero grants issued yet.
        role: grantsByAgent.has(row.did) ? 'grant' : 'connected',
        isExternal: externalDidByAgent.has(row.did),
        externalDid: externalDidByAgent.get(row.did) ?? null,
        grants: grantsByAgent.get(row.did) ?? [],
        hasLegacyMembership: legacyMembershipDids.has(row.did),
      })),
    ];

    return NextResponse.json({ agents });
  } catch (error) {
    log.error({ err: String(error) }, '[agents] List error');
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

/**
 * POST /auth/api/agents
 * Create a new agent identity linked to the authenticated user.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  // Resolve the acting DID (#1717): an agent created while acting on behalf of
  // a business/app DID must be owned by (and delegated to) that acting DID —
  // not the caller's raw personal session DID.
  const actingDid = resolveActingDid(authResult.identity);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { handle, displayName, bio } = body as {
    handle?: string;
    displayName?: string;
    bio?: string;
  };

  // Validate handle
  if (!handle || typeof handle !== 'string') {
    return NextResponse.json({ error: 'handle is required' }, { status: 400 });
  }
  if (handle.length < 3 || handle.length > 64) {
    return NextResponse.json({ error: 'Handle must be 3-64 characters' }, { status: 400 });
  }
  if (!HANDLE_REGEX.test(handle)) {
    return NextResponse.json(
      { error: 'Handle must be lowercase letters, numbers, underscores, or hyphens' },
      { status: 400 }
    );
  }

  // Validate display name
  const trimmedDisplayName = displayName?.trim().slice(0, 100) || null;

  try {
    // Check handle uniqueness
    const existing = await db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.handle, handle))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ error: 'Handle already taken' }, { status: 409 });
    }

    // Generate Ed25519 keypair server-side
    const { privateKey, publicKey } = generateKeypair();
    const agentDid = didFromPublicKey(publicKey);

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (bio && typeof bio === 'string') {
      metadata.bio = bio.trim().slice(0, 500);
    }

    // Insert the identity row and both membership links atomically (#1717):
    // if any step fails partway through, the whole creation rolls back rather
    // than leaving an orphaned identity row with no owning membership link.
    await db.transaction(async (tx) => {
      // Insert identity
      await tx.insert(identities).values({
        id: agentDid,
        scope: 'actor',
        subtype: 'agent',
        publicKey,
        handle,
        name: trimmedDisplayName,
        tier: 'preliminary',
        metadata: Object.keys(metadata).length > 0 ? metadata : {},
      });

      // Link agent to owner
      await tx.insert(identityMembers).values({
        identityDid: agentDid,
        memberDid: actingDid,
        role: 'owner',
        addedBy: actingDid,
        addedVia: 'direct',
      });

      // Reverse membership: agent is delegated to the acting DID
      await tx.insert(identityMembers).values({
        identityDid: actingDid,
        memberDid: agentDid,
        role: 'agent',
        addedBy: actingDid,
        addedVia: 'agent',
      });
    });

    return NextResponse.json(
      {
        did: agentDid,
        handle,
        displayName: trimmedDisplayName,
        name: trimmedDisplayName,
        scope: 'actor',
        subtype: 'agent',
        tier: 'preliminary',
        publicKey,
        keypair: {
          privateKey,
          publicKey,
        },
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    log.error({ err: String(error) }, '[agents] Create error');
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
