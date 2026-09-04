/**
 * Retrace (#1962) storage layer: fetches one artifact by ref and resolves
 * its parent link per the documented rule for that kind. See
 * `docs/agents/retrace-view.md` for the authoritative, human-readable
 * version of the rules implemented here.
 *
 * Read-only, no schema migration: `agentProvisions` and `attestations` are
 * existing Drizzle tables; `auditLog` (apps/kernel/src/db/schemas/bus.ts)
 * is a read-only mirror of the table `packages/bus`'s audit-log reactor
 * already writes to (migrations/0077_audit_log.sql) — see that schema
 * file's docblock.
 */
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { db, attestations, agentProvisions, auditLog, identities, type Attestation, type AgentProvisionRow, type AuditLogRow } from '@/src/db';
import { canonicalize, verifySync, isDisclosureScope, capabilityForDelegatedAttestationType } from '@imajin/auth';
import { trustRadius } from '@imajin/trust-graph';
import { canReadHop } from './authorize';
import type { ArtifactKind, ArtifactRef, HopRecord, HopSignatureStatus, RetraceRepository } from './types';

const ATTESTATION_ID_PREFIX = 'att_';
const PROVISION_ID_PREFIX = 'prov_';
const USAGE_ATTESTATION_TYPE = 'agent.turn.usage';

/**
 * Identify which table an artifact id belongs to. `attestation` and
 * `agent_provision` ids are self-describing (`att_*` / `prov_*` per
 * `apps/kernel/src/lib/kernel/id.ts`); anything else is assumed to be a
 * `kernel.audit_log` row, whose ids are opaque `randomUUID()`s. An explicit
 * `kind` query param always wins, for a caller that already knows better.
 */
export function identifyArtifactKind(id: string, explicitKind?: string | null): ArtifactKind {
  if (explicitKind === 'attestation' || explicitKind === 'agent_provision' || explicitKind === 'bus_event') {
    return explicitKind;
  }
  if (id.startsWith(ATTESTATION_ID_PREFIX)) return 'attestation';
  if (id.startsWith(PROVISION_ID_PREFIX)) return 'agent_provision';
  return 'bus_event';
}

function sessionOf(payload: unknown): string | null {
  const session = (payload as { session?: unknown } | null)?.session;
  return typeof session === 'string' ? session : null;
}

/** Verify an attestation's signature the same way `POST /auth/api/attestations` computed it at issuance. */
async function verifyAttestationSignature(row: Attestation): Promise<HopSignatureStatus> {
  if (!row.signature) return 'unsigned';

  const [issuer] = await db.select({ publicKey: identities.publicKey }).from(identities).where(eq(identities.id, row.issuerDid)).limit(1);
  if (!issuer) return 'invalid';

  const canonicalPayload = canonicalize({
    subject_did: row.subjectDid,
    type: row.type,
    context_id: row.contextId ?? null,
    context_type: row.contextType ?? null,
    payload: row.payload ?? null,
    issued_at: new Date(row.issuedAt).getTime(),
  });

  return verifySync(row.signature, canonicalPayload, issuer.publicKey) ? 'verified' : 'invalid';
}

/**
 * Parent-link rule for `agent.turn.usage` attestations that carry no
 * `prevEventRef`: the immediately preceding turn in the same session, for
 * the same subject — i.e. the same "previous turn" the usage-rollup route
 * (`GET /auth/api/attestations/usage`) computes `tokenDelta` against.
 */
async function findPreviousTurnInSession(row: Attestation): Promise<string | null> {
  const session = sessionOf(row.payload);
  if (!session) return null;

  const rows = await db
    .select({ id: attestations.id, issuedAt: attestations.issuedAt, payload: attestations.payload })
    .from(attestations)
    .where(and(eq(attestations.type, USAGE_ATTESTATION_TYPE), eq(attestations.subjectDid, row.subjectDid), isNull(attestations.revokedAt)));

  const rowIssuedAt = new Date(row.issuedAt).getTime();
  const priorInSession = rows
    .filter((r) => r.id !== row.id && sessionOf(r.payload) === session && new Date(r.issuedAt).getTime() < rowIssuedAt)
    .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());

  return priorInSession[0]?.id ?? null;
}

/**
 * Attestation parent-link rule, in priority order:
 *   1. `prevEventRef` — explicit funnel/causal predecessor.
 *   2. `agent.turn.usage` rows — the previous turn in the same session.
 *   3. `contextType === 'event'` — the bus event this attestation's own
 *      creation was a reaction to.
 *   4. none — terminal.
 */
async function resolveAttestationParent(row: Attestation): Promise<{ parent: ArtifactRef | null; terminalReason: string | null }> {
  if (row.prevEventRef) {
    return { parent: { kind: 'attestation', id: row.prevEventRef }, terminalReason: null };
  }
  if (row.type === USAGE_ATTESTATION_TYPE) {
    const previousTurnId = await findPreviousTurnInSession(row);
    if (previousTurnId) return { parent: { kind: 'attestation', id: previousTurnId }, terminalReason: null };
  }
  if (row.contextType === 'event' && row.contextId) {
    return { parent: { kind: 'bus_event', id: row.contextId }, terminalReason: null };
  }
  return { parent: null, terminalReason: 'No prev_event_ref, session predecessor, or context event — originating signed intent.' };
}

async function fetchAttestationHop(id: string): Promise<HopRecord | null> {
  const [row] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);
  if (!row) return null;

  const [signature, { parent, terminalReason }] = await Promise.all([verifyAttestationSignature(row), resolveAttestationParent(row)]);
  const capability = row.delegationGrantId ? capabilityForDelegatedAttestationType(row.type) : undefined;

  return {
    ref: { kind: 'attestation', id: row.id },
    actorDid: row.issuerDid,
    onBehalfOf: row.delegatorDid,
    grant: row.delegationGrantId ? { grantId: row.delegationGrantId, capability: capability ?? undefined } : null,
    route: 'attestation.created',
    timestamp: new Date(row.issuedAt).toISOString(),
    signature,
    audience: {
      subjectDid: row.subjectDid,
      actorDid: row.issuerDid,
      delegatorDid: row.delegatorDid,
      disclosureScope: isDisclosureScope(row.disclosureScope) ? row.disclosureScope : 'parties',
    },
    parent,
    terminalReason,
  };
}

/**
 * Provisions carry no parent link (RFC-31 v2 provisioning requests are
 * session-authenticated, not chained signed artifacts) — every provision
 * hop terminates the walk, representing the origin of the agent identity it
 * minted. See "not yet walkable" in the PR body for the reasoning.
 */
async function fetchProvisionHop(id: string): Promise<HopRecord | null> {
  const [row]: AgentProvisionRow[] = await db.select().from(agentProvisions).where(eq(agentProvisions.id, id)).limit(1);
  if (!row) return null;

  return {
    ref: { kind: 'agent_provision', id: row.id },
    actorDid: row.servingDid,
    onBehalfOf: null,
    grant: row.grantId ? { grantId: row.grantId } : null,
    route: 'agent.provisioned',
    timestamp: new Date(row.createdAt).toISOString(),
    signature: 'unsigned',
    audience: {
      subjectDid: row.agentDid ?? row.id,
      actorDid: row.servingDid,
      delegatorDid: row.delegatorDid,
      disclosureScope: null,
    },
    parent: null,
    terminalReason: "Provisioning requests are session-authenticated, not a chained signed artifact — this is the agent identity's origin.",
  };
}

function stringField(payload: unknown, field: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : null;
}

/**
 * bus_event parent-link rule, in priority order:
 *   1. `payload.attestationId` — the attestation whose creation published this event.
 *   2. `payload.provisionId` — the provision whose creation published this event.
 *   3. the immediately preceding `audit_log` row sharing this row's `correlationId`.
 *   4. none — terminal.
 */
async function resolveBusEventParent(row: AuditLogRow): Promise<{ parent: ArtifactRef | null; terminalReason: string | null }> {
  const attestationId = stringField(row.payload, 'attestationId');
  if (attestationId) return { parent: { kind: 'attestation', id: attestationId }, terminalReason: null };

  const provisionId = stringField(row.payload, 'provisionId');
  if (provisionId) return { parent: { kind: 'agent_provision', id: provisionId }, terminalReason: null };

  if (row.correlationId) {
    const [predecessor] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.correlationId, row.correlationId), lt(auditLog.createdAt, row.createdAt)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    if (predecessor) return { parent: { kind: 'bus_event', id: predecessor.id }, terminalReason: null };
  }

  return { parent: null, terminalReason: 'No payload-linked artifact or correlated predecessor event — earliest known event in this chain.' };
}

async function fetchBusEventHop(id: string): Promise<HopRecord | null> {
  const [row]: AuditLogRow[] = await db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
  if (!row) return null;

  const { parent, terminalReason } = await resolveBusEventParent(row);
  const onBehalfOf = stringField(row.payload, 'delegatorDid');
  const grantId = stringField(row.payload, 'grantId');

  return {
    ref: { kind: 'bus_event', id: row.id },
    actorDid: row.issuer,
    onBehalfOf,
    grant: grantId ? { grantId } : null,
    route: row.eventType,
    timestamp: new Date(row.createdAt).toISOString(),
    signature: 'unsigned',
    audience: { subjectDid: row.subject, actorDid: row.issuer, delegatorDid: onBehalfOf, disclosureScope: null },
    parent,
    terminalReason,
  };
}

async function fetchHop(ref: ArtifactRef): Promise<HopRecord | null> {
  switch (ref.kind) {
    case 'attestation':
      return fetchAttestationHop(ref.id);
    case 'agent_provision':
      return fetchProvisionHop(ref.id);
    case 'bus_event':
      return fetchBusEventHop(ref.id);
  }
}

/**
 * The real, DB-backed repository. Memoizes each viewer's trust-graph
 * radius-1 neighborhood for the lifetime of one request/walk, rather than
 * re-querying it per hop.
 */
export function createDefaultRepository(): RetraceRepository {
  const connectedDidsByViewer = new Map<string, Promise<Set<string>>>();

  function connectedDidsFor(viewerDid: string): Promise<Set<string>> {
    let cached = connectedDidsByViewer.get(viewerDid);
    if (!cached) {
      cached = trustRadius(db, viewerDid, 1);
      connectedDidsByViewer.set(viewerDid, cached);
    }
    return cached;
  }

  return {
    fetch: fetchHop,
    canRead: async (viewerDid, audience) => canReadHop(viewerDid, audience, await connectedDidsFor(viewerDid)),
  };
}
