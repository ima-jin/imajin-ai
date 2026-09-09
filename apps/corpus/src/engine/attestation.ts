/**
 * Ingestion attestation construction + signing (#1750).
 *
 * Pure functions only — no I/O, no SQLite. `CorpusStore.ingest()` calls
 * these to build+sign an `IngestionAttestation` per source in a batch;
 * persistence lives in `store.ts`, forwarding to the kernel lives in
 * `lib/attestation-forwarder.ts`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { CorpusIdentity } from '../lib/corpus-identity';
import type { IngestionAttestation } from './types';

/** A single (docId, updated) pair the content hash is computed over. */
export interface ContentHashInput {
  docId: string;
  updated: string;
}

/**
 * sha256 over the sorted `(docId, updated)` pairs of an ingested batch.
 * Sorted so the hash is independent of the batch's original ordering —
 * the same set of documents always hashes the same way regardless of how
 * an adapter happened to enumerate them.
 */
export function computeContentHash(pairs: ContentHashInput[]): string {
  const sorted = [...pairs].sort((left, right) => {
    if (left.docId !== right.docId) return left.docId < right.docId ? -1 : 1;
    if (left.updated < right.updated) return -1;
    if (left.updated > right.updated) return 1;
    return 0;
  });
  const serialized = sorted.map(pair => `${pair.docId}:${pair.updated}`).join('|');
  return createHash('sha256').update(serialized).digest('hex');
}

function generateAttestationId(): string {
  return `ing_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export interface BuildIngestionAttestationParams {
  identity: CorpusIdentity;
  source: string;
  corpusDid: string;
  ingesterDid: string;
  documentPairs: ContentHashInput[];
  /** Defaults to now; callers pass the batch's `syncedAt` for reproducibility in tests. */
  timestamp?: string;
}

/**
 * Builds and signs an `IngestionAttestation` over
 * `canonicalize({source, corpusDid, ingesterDid, contentHash, threadCount, timestamp})`
 * using the corpus service's own key — never the kernel's.
 */
export function buildIngestionAttestation(params: BuildIngestionAttestationParams): IngestionAttestation {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const contentHash = computeContentHash(params.documentPairs);
  const threadCount = params.documentPairs.length;

  const unsigned = {
    source: params.source,
    corpusDid: params.corpusDid,
    ingesterDid: params.ingesterDid,
    contentHash,
    threadCount,
    timestamp,
  };
  const signature = authCrypto.signSync(canonicalize(unsigned), params.identity.privateKey);

  return { id: generateAttestationId(), ...unsigned, signature };
}
