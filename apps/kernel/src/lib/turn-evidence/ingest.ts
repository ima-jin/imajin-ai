/**
 * Signed ingest for `agent.turn.evidence` (#1978).
 *
 * Follows the loops-rail signed-ingest pattern (`../loops/ingest.ts`, #2295 /
 * #2358) but lands as attestations — the issue's chosen primitive — rather
 * than a new bus kind or table:
 *
 *   1. every item's Ed25519 signature is verified against the agent DID's
 *      *current* registered key (fails closed; nothing is written if any item
 *      fails),
 *   2. the agent is authorized to publish for the named principal
 *      (self-attestation, or an active `evidence:publish` delegation grant —
 *      `./authorize-publisher.ts`),
 *   3. `usageRef` (if any) must point at that agent's own `agent.turn.usage`
 *      attestation — the evidence → usage link is checked, not trusted,
 *   4. `outputRef` (raw-output retention) is accepted only for tools on the
 *      evidentiary allowlist, and only when the media asset is owned by the
 *      principal and its content hash equals the signed `outputHash`,
 *   5. rows are inserted in one statement, idempotently: replaying a batch
 *      (same agent, turn, `seq`) never duplicates or mutates a row.
 *
 * The kernel never reaches into a harness. It stores and verifies what the
 * agent published; it does not scrape transcripts or hold session keys.
 *
 * All I/O is behind {@link IngestDeps} so the verification logic is testable
 * with real signatures and no database; `./ingest-deps.ts` supplies the
 * production implementations.
 */
import { crypto as authCrypto, turnEvidenceSigningMessage, TURN_EVIDENCE_CONTEXT_TYPE, TURN_EVIDENCE_ATTESTATION_TYPE } from '@imajin/auth';
import type { TurnEvidencePayload } from '@imajin/auth';
import type { TurnEvidenceBatch, TurnEvidenceItem } from './types';

export type AuthorizeResult = { authorized: true; grantId: string | null } | { authorized: false };

export interface RetainedAsset {
  ownerDid: string;
  /** Hex SHA-256 of the asset's content (`media.assets.hash`), no prefix. */
  hash: string;
}

/** A row ready for insertion into `auth.attestations`. */
export interface EvidenceRow {
  id: string;
  issuerDid: string;
  subjectDid: string;
  type: typeof TURN_EVIDENCE_ATTESTATION_TYPE;
  contextId: string;
  contextType: typeof TURN_EVIDENCE_CONTEXT_TYPE;
  payload: TurnEvidencePayload;
  signature: string;
  delegatorDid: string | null;
  delegationGrantId: string | null;
  issuedAt: Date;
}

export interface InsertedEvidence {
  id: string;
  seq: number;
}

export interface IngestDeps {
  /** Current Ed25519 public key (hex) for a DID, or `null` when unresolvable. */
  resolveIssuerKey(did: string): Promise<string | null>;
  authorizePublisher(agentDid: string, principalDid: string): Promise<AuthorizeResult>;
  /** Of `ids`, the ones that are live `agent.turn.usage` attestations whose subject is `agentDid`. */
  findOwnUsageRefs(ids: readonly string[], agentDid: string): Promise<ReadonlySet<string>>;
  findAssets(ids: readonly string[]): Promise<ReadonlyMap<string, RetainedAsset>>;
  /** Insert rows, skipping any that collide on (issuer, turn, seq). Returns only the rows actually inserted. */
  insertEvidence(rows: readonly EvidenceRow[]): Promise<InsertedEvidence[]>;
  /** Fire-and-forget bus notification for an inserted row. Must not throw. */
  announce(row: EvidenceRow): void;
  evidentiaryTools(): ReadonlySet<string>;
  newId(): string;
}

export type IngestResult =
  | { ok: true; turnEventId: string; inserted: InsertedEvidence[]; duplicateSeqs: number[] }
  | { ok: false; error: string; status: number; code?: string };

type Failure = Extract<IngestResult, { ok: false }>;

function fail(status: number, error: string, code?: string): Failure {
  return code ? { ok: false, error, status, code } : { ok: false, error, status };
}

function verifyItemSignatures(items: readonly TurnEvidenceItem[], publicKey: string): Failure | null {
  const normalizedKey = publicKey.toLowerCase();
  for (const item of items) {
    const message = turnEvidenceSigningMessage(item.payload, item.issuedAt);
    if (!authCrypto.verifySync(item.signature, message, normalizedKey)) {
      return fail(400, `Invalid signature for evidence seq ${item.payload.seq}`, 'evidence_signature_invalid');
    }
  }
  return null;
}

async function checkUsageRefs(batch: TurnEvidenceBatch, deps: IngestDeps): Promise<Failure | null> {
  const refs = [...new Set(batch.items.flatMap(({ payload }) => (payload.usageRef ? [payload.usageRef] : [])))];
  if (refs.length === 0) return null;

  const found = await deps.findOwnUsageRefs(refs, batch.agentDid);
  const missing = refs.find((ref) => !found.has(ref));
  if (missing === undefined) return null;
  return fail(
    422,
    'usageRef must reference an existing agent.turn.usage attestation issued for this agent',
    'evidence_usage_ref_unresolved',
  );
}

function checkRetentionItem(
  payload: TurnEvidencePayload,
  assets: ReadonlyMap<string, RetainedAsset>,
  evidentiary: ReadonlySet<string>,
): Failure | null {
  if (!payload.outputRef) return null;
  if (!evidentiary.has(payload.tool.name)) {
    return fail(422, `Tool "${payload.tool.name}" is not evidentiary; its raw output may not be retained`, 'evidence_tool_not_evidentiary');
  }
  const asset = assets.get(payload.outputRef);
  if (asset?.ownerDid !== payload.principalDid) {
    // Same response whether the asset is missing or someone else's — never confirm another owner's asset ids.
    return fail(422, 'outputRef must reference a media asset owned by the principal', 'evidence_output_ref_invalid');
  }
  if (`sha256:${asset.hash.toLowerCase()}` !== payload.outputHash) {
    return fail(422, 'outputRef asset content does not match outputHash', 'evidence_output_ref_mismatch');
  }
  return null;
}

async function checkRetention(batch: TurnEvidenceBatch, deps: IngestDeps): Promise<Failure | null> {
  const refs = [...new Set(batch.items.flatMap(({ payload }) => (payload.outputRef ? [payload.outputRef] : [])))];
  if (refs.length === 0) return null;

  const assets = await deps.findAssets(refs);
  const evidentiary = deps.evidentiaryTools();
  for (const { payload } of batch.items) {
    const failure = checkRetentionItem(payload, assets, evidentiary);
    if (failure) return failure;
  }
  return null;
}

function toRow(item: TurnEvidenceItem, grantId: string | null, id: string): EvidenceRow {
  const { payload } = item;
  return {
    id,
    issuerDid: payload.agentDid,
    // Subject is the agent itself — the same subject its `agent.turn.usage`
    // rows carry — so the usage route's authorization (`canReadUsage`)
    // covers reading the evidence counts alongside it.
    subjectDid: payload.agentDid,
    type: TURN_EVIDENCE_ATTESTATION_TYPE,
    contextId: payload.turnEventId,
    contextType: TURN_EVIDENCE_CONTEXT_TYPE,
    payload,
    signature: item.signature,
    delegatorDid: payload.principalDid === payload.agentDid ? null : payload.principalDid,
    delegationGrantId: grantId,
    issuedAt: new Date(item.issuedAt),
  };
}

/**
 * Verify and persist one turn's evidence batch. Never throws for a rejected
 * batch — every rejection path returns `{ ok: false }` before anything is
 * written. Storage failures propagate to the caller (mapped to a 500).
 */
export async function ingestTurnEvidence(batch: TurnEvidenceBatch, deps: IngestDeps): Promise<IngestResult> {
  const publicKey = await deps.resolveIssuerKey(batch.agentDid);
  if (!publicKey) return fail(400, 'agentDid could not be resolved to a registered public key', 'evidence_agent_unknown');

  const badSignature = verifyItemSignatures(batch.items, publicKey);
  if (badSignature) return badSignature;

  const authorization = await deps.authorizePublisher(batch.agentDid, batch.principalDid);
  if (!authorization.authorized) {
    return fail(403, 'agentDid is not authorized to publish evidence for principalDid', 'evidence_publisher_unauthorized');
  }

  const usageFailure = await checkUsageRefs(batch, deps);
  if (usageFailure) return usageFailure;

  const retentionFailure = await checkRetention(batch, deps);
  if (retentionFailure) return retentionFailure;

  const rows = batch.items.map((item) => toRow(item, authorization.grantId, deps.newId()));
  const inserted = await deps.insertEvidence(rows);

  const insertedIds = new Set(inserted.map(({ id }) => id));
  for (const row of rows) {
    if (insertedIds.has(row.id)) deps.announce(row);
  }
  const insertedSeqs = new Set(inserted.map(({ seq }) => seq));
  const duplicateSeqs = batch.items.map(({ payload }) => payload.seq).filter((seq) => !insertedSeqs.has(seq));

  return { ok: true, turnEventId: batch.turnEventId, inserted, duplicateSeqs };
}
