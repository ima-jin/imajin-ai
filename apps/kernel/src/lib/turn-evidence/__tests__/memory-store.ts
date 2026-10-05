/**
 * In-memory stand-in for the attestations table behind both
 * {@link IngestDeps} and {@link VerifyDeps} (#1978), so ingest -> verify can
 * be tested end to end with real signatures and no database. It enforces the
 * same unique (issuer, turn event, seq) constraint as
 * migrations/0169_turn_evidence_indexes.sql.
 */
import { vi } from 'vitest';
import type { AuthorizeResult, EvidenceRow, IngestDeps, RetainedAsset } from '../ingest';
import type { StoredEvidenceRow, TurnEventRef, VerifyDeps } from '../verify';
import { AGENT_DID, AGENT_KEYPAIR, PRINCIPAL_DID } from './helpers';

export interface MemoryStoreOptions {
  authorize?: (agentDid: string, principalDid: string) => AuthorizeResult;
  usageIds?: string[];
  assets?: Record<string, RetainedAsset>;
  evidentiaryTools?: string[];
  turnEvents?: Record<string, TurnEventRef>;
  keys?: Record<string, string>;
}

export function createMemoryStore(options: MemoryStoreOptions = {}) {
  const rows: EvidenceRow[] = [];
  const keys = options.keys ?? { [AGENT_DID]: AGENT_KEYPAIR.publicKey };
  let nextId = 0;

  const authorize =
    options.authorize ??
    ((agentDid: string, principalDid: string): AuthorizeResult =>
      agentDid === principalDid || principalDid === PRINCIPAL_DID
        ? { authorized: true, grantId: agentDid === principalDid ? null : 'grant_1' }
        : { authorized: false });

  const announce = vi.fn();

  const ingestDeps: IngestDeps = {
    resolveIssuerKey: vi.fn(async (did: string) => keys[did] ?? null),
    authorizePublisher: vi.fn(async (agentDid: string, principalDid: string) => authorize(agentDid, principalDid)),
    findOwnUsageRefs: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => options.usageIds?.includes(id)))),
    findAssets: vi.fn(async (ids: readonly string[]) => {
      const found = new Map<string, RetainedAsset>();
      for (const id of ids) {
        const asset = options.assets?.[id];
        if (asset) found.set(id, asset);
      }
      return found;
    }),
    insertEvidence: vi.fn(async (incoming: readonly EvidenceRow[]) => {
      const inserted: { id: string; seq: number }[] = [];
      for (const row of incoming) {
        const clash = rows.some(
          (existing) =>
            existing.issuerDid === row.issuerDid &&
            existing.contextId === row.contextId &&
            existing.payload.seq === row.payload.seq,
        );
        if (clash) continue;
        rows.push(row);
        inserted.push({ id: row.id, seq: row.payload.seq });
      }
      return inserted;
    }),
    announce,
    evidentiaryTools: () => new Set(options.evidentiaryTools ?? ['web_fetch', 'chain_read']),
    newId: () => `att_mem${nextId++}`,
  };

  const verifyDeps: VerifyDeps = {
    findEvidenceByTurnOutputHash: vi.fn(async (hash: string): Promise<StoredEvidenceRow[]> =>
      rows
        .filter((row) => row.payload.turnOutputHash === hash)
        .map((row) => ({
          id: row.id,
          issuerDid: row.issuerDid,
          subjectDid: row.subjectDid,
          type: row.type,
          contextId: row.contextId,
          contextType: row.contextType,
          payload: structuredClone(row.payload) as unknown,
          signature: row.signature,
          issuedAt: row.issuedAt,
        })),
    ),
    resolveIssuerKey: vi.fn(async (did: string) => keys[did] ?? null),
    resolveTurnEvent: vi.fn(async (id: string) => options.turnEvents?.[id] ?? null),
    usageExists: vi.fn(async (id: string) => options.usageIds?.includes(id) ?? false),
  };

  return { rows, ingestDeps, verifyDeps, announce };
}
