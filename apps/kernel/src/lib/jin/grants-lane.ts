/**
 * Grants lane read projection (#2292) — "who acts for me with what
 * capabilities", normalized across every EXISTING standing-authority
 * source in the kernel. Zero new backend: every row here is read through
 * an already-shipped list surface (calling the same in-process functions
 * the source's own route/panel already uses — no self-HTTP call,
 * matching the precedent in `app/jin/api/vault-proposals/route.ts`), and
 * every one-tap revoke in the panel posts to the source's own EXISTING
 * revoke/DELETE route. This module only reads and normalizes; it never
 * mutates anything.
 *
 * Sources (see #2288's Inventory section for the full route survey):
 *   - `auth-grant`      — scoped delegation grants (#1882), one card per
 *                         `DelegationGrantDetail` from
 *                         `listGrantDetailsForDelegator` (already backs
 *                         `GET /auth/api/agents` and the `/auth/agents`
 *                         page). Revoke: `DELETE /auth/api/grants/:grantId`.
 *   - `auth-membership` — the coarse, pre-#1882 `identity_members`
 *                         role='owner'|'agent' bootstrap (#1881's Day-1
 *                         audit gap: no grant/revoke lifecycle, no
 *                         capabilities, no expiry). Queried here directly
 *                         since `GET /auth/api/agents`'s own query for this
 *                         half isn't exported as a reusable function.
 *                         Revoke: `DELETE /auth/api/agents/:did`.
 *   - `vault-delegation` — the grant a vault-minted key was delivered
 *                         through (#2247/#2235), sourced from
 *                         `listVaultKeyCards()` (already backs
 *                         `GET /api/vault/mint/cards` / VaultKeysPanel) so
 *                         the subject direction matches "who has access to
 *                         MY vault keys" — the self-service
 *                         `GET /api/vault/delegation/grants` route lists
 *                         the opposite direction (grants where the CALLER
 *                         is the grantee), which is not this lane's
 *                         question. Revoke: `POST /api/vault/delegation/revoke`.
 *   - `access-bearer`   — delegate-grant bearers (#2252), sourced from
 *                         `listDelegateGrantBearersForPrincipal` (already
 *                         backs `GET /auth/api/access/bearers` /
 *                         AccessBearersPanel). Revoke:
 *                         `POST /auth/api/access/bearers/:id/revoke`.
 *   - `app-authorization` — MCP/OAuth client authorizations, which project
 *                         into an `auth.channel_links` row per (owner, app)
 *                         (#1803's `app-authorization-grant.ts`). Queried
 *                         here directly, mirroring `GET /api/auth/apps`'s
 *                         own query (also not exported as a reusable
 *                         function). Revoke: `POST /api/auth/revoke`.
 *
 * Known gap (documented, not silently worked around): a vault field can
 * carry MORE than one active consumer grant once a second consumer is
 * added via `grantExistingMintedKey` (#2247's "Grant access" button) —
 * `vault_minted_keys.grantId` only ever points at the ORIGINAL grant, so
 * `listVaultKeyCards()` (and therefore this lane) only surfaces that one.
 * There is no existing subject-scoped route that lists every active grant
 * per field. Filed as a follow-up child issue under #2292 rather than
 * querying `vault_delegation_grants` directly here, which would be a new,
 * un-audited read path this PR didn't otherwise need.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, identities, identityMembers, attestations, registryApps } from '@/src/db';
import { listGrantDetailsForDelegator } from '@/src/lib/auth/grants';
import { listVaultKeyCards } from '@/src/lib/vault';
import { mintedKeyField } from '@/src/lib/vault/mint';
import { listDelegateGrantBearersForPrincipal } from '@/src/lib/access/delegate-grant';

export type GrantSourceKind =
  | 'auth-grant'
  | 'auth-membership'
  | 'vault-delegation'
  | 'access-bearer'
  | 'app-authorization';

export type DeferredAckState = 'used' | 'failed' | 'discarded' | 'pending';

export interface GrantAckEvidence {
  kind?: string;
  ref?: string;
  note?: string;
}

export interface RevokeAction {
  method: 'DELETE' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

export interface GrantCard {
  id: string;
  source: GrantSourceKind;
  /** Agent DID / OAuth client label / bearer client label — never a secret value. */
  grantee: string;
  /** Non-secret capability/scope labels — a purpose string for vault, a coarse role for legacy membership. */
  capabilities: string[];
  issuedAt: string | null;
  lastUsedAt: string | null;
  ackState: DeferredAckState | null;
  ackEvidence: GrantAckEvidence | null;
  status: string;
  revocable: boolean;
  revoke: RevokeAction | null;
}

// ── auth-membership (coarse identity_members bootstrap) ─────────────────────

export interface LegacyAgentMembership {
  agentDid: string;
  role: string;
  addedAt: string | null;
}

/**
 * The caller's coarse `identity_members` role='owner'|'agent' memberships —
 * the SAME query `GET /auth/api/agents` runs for its `ownedRows`, extracted
 * here rather than imported from that route (its logic isn't exported) so
 * this module can read it in-process. Read-only: revocation for these rows
 * is `DELETE /auth/api/agents/:did`, which this module never calls.
 */
export async function listLegacyAgentMemberships(actingDid: string): Promise<LegacyAgentMembership[]> {
  const rows = await db
    .select({
      agentDid: identities.id,
      role: identityMembers.role,
      addedAt: identityMembers.addedAt,
    })
    .from(identityMembers)
    .innerJoin(identities, eq(identityMembers.identityDid, identities.id))
    .where(
      and(
        eq(identityMembers.memberDid, actingDid),
        isNull(identityMembers.removedAt),
        eq(identities.subtype, 'agent'),
        eq(identities.scope, 'actor'),
      ),
    );

  type Row = (typeof rows)[number];
  return rows.map((row: Row) => ({
    agentDid: row.agentDid,
    role: row.role,
    addedAt: row.addedAt ? row.addedAt.toISOString() : null,
  }));
}

// ── app-authorization (MCP/OAuth clients projected into channel_links) ──────

export interface AppAuthorizationSummary {
  attestationId: string;
  appDid: string;
  appName: string;
  scopes: string[];
  authorizedAt: string;
  revokedAt: string | null;
}

/**
 * Every `app.authorized` attestation this owner has issued — the SAME query
 * `GET /api/auth/apps` runs, extracted here rather than imported from that
 * route (its logic isn't exported) so this module can read it in-process.
 * Includes revoked authorizations (revokedAt set) — the record doesn't
 * disappear because the authority did, same posture as the agent-grants
 * source above.
 */
export async function listAppAuthorizationsForOwner(ownerDid: string): Promise<AppAuthorizationSummary[]> {
  const authorizations = await db
    .select({
      attestationId: attestations.id,
      appDid: attestations.subjectDid,
      payload: attestations.payload,
      issuedAt: attestations.issuedAt,
      revokedAt: attestations.revokedAt,
    })
    .from(attestations)
    .where(and(eq(attestations.issuerDid, ownerDid), eq(attestations.type, 'app.authorized')));

  if (authorizations.length === 0) return [];

  type AuthorizationRow = (typeof authorizations)[number];
  const appDids = [...new Set(authorizations.map((row: AuthorizationRow) => row.appDid))];
  const appRecords = await db
    .select({ appDid: registryApps.appDid, name: registryApps.name })
    .from(registryApps)
    .where(inArray(registryApps.appDid, appDids));
  type AppRecordRow = (typeof appRecords)[number];
  const nameByAppDid = new Map(appRecords.map((row: AppRecordRow) => [row.appDid, row.name]));

  return authorizations.map((row: AuthorizationRow) => {
    const payload = row.payload as { scopes?: string[] } | null;
    return {
      attestationId: row.attestationId,
      appDid: row.appDid,
      appName: nameByAppDid.get(row.appDid) ?? row.appDid,
      scopes: Array.isArray(payload?.scopes) ? payload.scopes : [],
      authorizedAt: row.issuedAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    };
  });
}

// ── normalization ────────────────────────────────────────────────────────────

function normalizeAuthGrants(grants: Awaited<ReturnType<typeof listGrantDetailsForDelegator>>): GrantCard[] {
  return grants.map((grant) => {
    const activeCapabilities = grant.capabilities.filter((c) => c.status === 'active').map((c) => c.capability);
    return {
      id: `auth-grant:${grant.grantId}`,
      source: 'auth-grant',
      grantee: grant.agentDid,
      capabilities: activeCapabilities.length > 0 ? activeCapabilities : ['(no active capabilities)'],
      issuedAt: grant.issuedAt,
      lastUsedAt: grant.lastUsedAt,
      ackState: null,
      ackEvidence: null,
      status: grant.status,
      revocable: grant.status !== 'revoked',
      revoke: grant.status === 'revoked' ? null : { method: 'DELETE', path: `/auth/api/grants/${encodeURIComponent(grant.grantId)}` },
    };
  });
}

function normalizeLegacyMemberships(memberships: LegacyAgentMembership[]): GrantCard[] {
  return memberships.map((membership) => ({
    id: `auth-membership:${membership.agentDid}`,
    source: 'auth-membership',
    grantee: membership.agentDid,
    capabilities: [membership.role],
    issuedAt: membership.addedAt,
    lastUsedAt: null,
    ackState: null,
    ackEvidence: null,
    status: 'active',
    revocable: true,
    revoke: { method: 'DELETE', path: `/auth/api/agents/${encodeURIComponent(membership.agentDid)}` },
  }));
}

function vaultAckState(ackOutcome: string | null, lastFetchedAt: string | null): DeferredAckState | null {
  if (ackOutcome === 'used' || ackOutcome === 'failed' || ackOutcome === 'discarded') return ackOutcome;
  return lastFetchedAt ? 'pending' : null;
}

function vaultAckEvidence(card: Awaited<ReturnType<typeof listVaultKeyCards>>[number]): GrantAckEvidence | null {
  const ackedEvent = card.timeline.find((event) => event.type === 'acked');
  const evidence = ackedEvent?.detail.evidence;
  return evidence && typeof evidence === 'object' ? (evidence as GrantAckEvidence) : null;
}

function normalizeVaultDelegationGrants(cards: Awaited<ReturnType<typeof listVaultKeyCards>>): GrantCard[] {
  const result: GrantCard[] = [];
  for (const card of cards) {
    const { grant } = card;
    if (!grant) continue;
    const grantedEvent = card.timeline.find((event) => event.type === 'granted');
    result.push({
      id: `vault-delegation:${grant.grantId}`,
      source: 'vault-delegation',
      grantee: grant.grantedTo,
      capabilities: [grant.purpose ?? card.purpose],
      issuedAt: grantedEvent?.at ?? card.createdAt,
      lastUsedAt: grant.lastFetchedAt,
      ackState: vaultAckState(grant.ackOutcome, grant.lastFetchedAt),
      ackEvidence: vaultAckEvidence(card),
      status: grant.status,
      revocable: grant.status === 'active',
      revoke: grant.status === 'active'
        ? { method: 'POST', path: '/api/vault/delegation/revoke', body: { field: mintedKeyField(card.did) } }
        : null,
    });
  }
  return result;
}

function normalizeAccessBearers(bearers: Awaited<ReturnType<typeof listDelegateGrantBearersForPrincipal>>): GrantCard[] {
  return bearers.map((bearer) => ({
    id: `access-bearer:${bearer.bearerId}`,
    source: 'access-bearer',
    grantee: bearer.clientLabel,
    capabilities: bearer.scopes,
    issuedAt: bearer.issuedAt,
    lastUsedAt: bearer.lastUsedAt,
    ackState: null,
    ackEvidence: null,
    status: bearer.status,
    revocable: bearer.status === 'active',
    revoke: bearer.status === 'active'
      ? { method: 'POST', path: `/auth/api/access/bearers/${encodeURIComponent(bearer.bearerId)}/revoke` }
      : null,
  }));
}

function normalizeAppAuthorizations(apps: AppAuthorizationSummary[]): GrantCard[] {
  return apps.map((app) => ({
    id: `app-authorization:${app.attestationId}`,
    source: 'app-authorization',
    grantee: app.appName,
    capabilities: app.scopes,
    issuedAt: app.authorizedAt,
    lastUsedAt: null,
    ackState: null,
    ackEvidence: null,
    status: app.revokedAt ? 'revoked' : 'active',
    revocable: !app.revokedAt,
    revoke: app.revokedAt ? null : { method: 'POST', path: '/api/auth/revoke', body: { attestationId: app.attestationId } },
  }));
}

/**
 * Aggregate every standing-authority source into one normalized card list
 * for the operator, sorted newest-issued first. Callers are responsible for
 * the operator-identity gate (see `app/jin/api/grants/route.ts`) — this
 * function does no authorization of its own, matching every other /jin/api
 * service function's split of "gate at the route, read in the service".
 */
export async function listGrantsForOperator(operatorDid: string): Promise<GrantCard[]> {
  const [authGrants, legacyMemberships, vaultKeyCards, accessBearers, appAuthorizations] = await Promise.all([
    listGrantDetailsForDelegator(operatorDid),
    listLegacyAgentMemberships(operatorDid),
    listVaultKeyCards(),
    listDelegateGrantBearersForPrincipal(operatorDid),
    listAppAuthorizationsForOwner(operatorDid),
  ]);

  const cards = [
    ...normalizeAuthGrants(authGrants),
    ...normalizeLegacyMemberships(legacyMemberships),
    ...normalizeVaultDelegationGrants(vaultKeyCards),
    ...normalizeAccessBearers(accessBearers),
    ...normalizeAppAuthorizations(appAuthorizations),
  ];

  return cards.sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''));
}
