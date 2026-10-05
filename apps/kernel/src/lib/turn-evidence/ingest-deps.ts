/**
 * Production implementations of {@link IngestDeps} (#1978) — the thin,
 * I/O-only layer under `./ingest.ts`.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, attestations, assets } from '@/src/db';
import { computeCid } from '@imajin/cid';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { resolveIssuerCredentials } from '@/app/auth/api/attestations/attestation-helpers';
import { generateId } from '@/src/lib/kernel/id';
import { authorizeEvidencePublisher } from './authorize-publisher';
import { getEvidentiaryTools } from './config';
import type { EvidenceRow, IngestDeps, InsertedEvidence, RetainedAsset } from './ingest';

const log = createLogger('kernel:turn-evidence');

const USAGE_ATTESTATION_TYPE = 'agent.turn.usage';

/** Current Ed25519 public key for an agent DID (identity registry, then active registered app). */
export async function resolveIssuerKey(did: string): Promise<string | null> {
  const credentials = await resolveIssuerCredentials(did);
  return credentials?.publicKey ?? null;
}

async function findOwnUsageRefs(ids: readonly string[], agentDid: string): Promise<ReadonlySet<string>> {
  const rows: { id: string }[] = await db
    .select({ id: attestations.id })
    .from(attestations)
    .where(
      and(
        inArray(attestations.id, [...ids]),
        eq(attestations.type, USAGE_ATTESTATION_TYPE),
        eq(attestations.subjectDid, agentDid),
        isNull(attestations.revokedAt),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

async function findAssets(ids: readonly string[]): Promise<ReadonlyMap<string, RetainedAsset>> {
  const rows: { id: string; ownerDid: string; hash: string }[] = await db
    .select({ id: assets.id, ownerDid: assets.ownerDid, hash: assets.hash })
    .from(assets)
    .where(and(inArray(assets.id, [...ids]), eq(assets.status, 'active')));
  return new Map(rows.map((row) => [row.id, { ownerDid: row.ownerDid, hash: row.hash }]));
}

/** Content address for the row; non-fatal if it fails, same as `POST /auth/api/attestations`. */
async function safeCid(row: EvidenceRow): Promise<string | null> {
  try {
    return await computeCid({
      issuerDid: row.issuerDid,
      subjectDid: row.subjectDid,
      type: row.type,
      contextId: row.contextId,
      contextType: row.contextType,
      payload: row.payload,
      issuedAt: row.issuedAt.getTime(),
    });
  } catch (err) {
    log.warn({ err: String(err), attestationId: row.id }, 'evidence cid computation failed');
    return null;
  }
}

/**
 * One multi-row INSERT — atomic by itself. `ON CONFLICT DO NOTHING` is
 * backed by `uniq_auth_attestations_turn_evidence_seq`
 * (migrations/0169_turn_evidence_indexes.sql): replaying a batch for the
 * same (issuer, turn, seq) inserts nothing and returns nothing for it.
 */
async function insertEvidence(rows: readonly EvidenceRow[]): Promise<InsertedEvidence[]> {
  const values = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      issuerDid: row.issuerDid,
      subjectDid: row.subjectDid,
      type: row.type,
      contextId: row.contextId,
      contextType: row.contextType,
      payload: row.payload as unknown as Record<string, unknown>,
      signature: row.signature,
      cid: await safeCid(row),
      // Unilateral, agent-signed fact: never awaiting a countersignature.
      // The column defaults to 'pending', which `POST /auth/api/attestations`
      // also overrides to null whenever there is no author_jws.
      attestationStatus: null,
      delegatorDid: row.delegatorDid,
      delegationGrantId: row.delegationGrantId,
      issuedAt: row.issuedAt,
    })),
  );

  const inserted: { id: string; payload: unknown }[] = await db
    .insert(attestations)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: attestations.id, payload: attestations.payload });

  return inserted.map((row) => ({ id: row.id, seq: (row.payload as { seq: number }).seq }));
}

function announce(row: EvidenceRow): void {
  publish('attestation.created', {
    issuer: row.issuerDid,
    subject: row.subjectDid,
    scope: 'auth',
    payload: {
      attestationId: row.id,
      type: row.type,
      issuerDid: row.issuerDid,
      subjectDid: row.subjectDid,
      contextId: row.contextId,
      contextType: row.contextType,
      pendingSignature: false,
    },
  }).catch((err: unknown) => {
    log.warn({ err: String(err), attestationId: row.id }, 'attestation.created publish failed for turn evidence');
  });
}

export const productionIngestDeps: IngestDeps = {
  resolveIssuerKey,
  authorizePublisher: authorizeEvidencePublisher,
  findOwnUsageRefs,
  findAssets,
  insertEvidence,
  announce,
  evidentiaryTools: () => getEvidentiaryTools(),
  newId: () => generateId('att'),
};
