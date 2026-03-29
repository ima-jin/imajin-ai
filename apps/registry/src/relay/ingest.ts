/**
 * DFOS 0.6.0 ingest logic
 *
 * Key differences from 0.5.0:
 * - Status values: 'new' (accepted for first time), 'duplicate' (idempotent re-submit), 'rejected'
 * - Fork/DAG model: chains are DAGs not strict linear; forks from non-head ops are accepted
 * - Deterministic head: tips sorted by (createdAt DESC, cid DESC)[0]
 * - Temporal guard: reject ops with createdAt > now + 24h
 */

import {
  verifyIdentityChain,
  verifyIdentityExtensionFromTrustedState,
  verifyContentChain,
  verifyContentExtensionFromTrustedState,
  verifyBeacon,
  verifyArtifact,
  verifyCountersignature,
  decodeMultikey,
  type VerifiedIdentity,
  type VerifiedContentChain,
} from '@metalabel/dfos-protocol/chain';
import { dagCborCanonicalEncode, decodeJwsUnsafe } from '@metalabel/dfos-protocol/crypto';
import type {
  RelayStore,
  StoredIdentityChain,
  StoredContentChain,
  OperationKind,
} from '@metalabel/dfos-web-relay';

export interface IngestionResult060 {
  cid: string;
  status: 'new' | 'duplicate' | 'rejected';
  error?: string;
  kind?: OperationKind;
  chainId?: string;
}

export interface SequencerStore {
  putPending(cid: string, jwsToken: string): Promise<void>;
  getPendingOps(): Promise<Array<{ cid: string; jwsToken: string; attempts: number }>>;
  updatePendingStatus(
    cid: string,
    status: 'pending' | 'resolved' | 'rejected',
    error?: string,
    incrementAttempts?: boolean,
  ): Promise<void>;
}

// ─── Ingest mutex ─────────────────────────────────────────────────────────────

let _ingestLock: Promise<void> = Promise.resolve();

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = _ingestLock;
  _ingestLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── Dependency error detection ───────────────────────────────────────────────

function isDependencyError(error: string): boolean {
  return (
    error.includes('unknown identity:') ||
    error.includes('unknown key ') ||
    error.includes('unknown previous operation:') ||
    error.includes('content chain not found:')
  );
}

// ─── Temporal guard ──────────────────────────────────────────────────────────

const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // 24 hours

function isWithinTemporalWindow(createdAt: string): boolean {
  const opTime = new Date(createdAt).getTime();
  return opTime <= Date.now() + MAX_FUTURE_MS;
}

// ─── DAG helpers ─────────────────────────────────────────────────────────────

function getOpCid(jws: string): string | null {
  const decoded = decodeJwsUnsafe(jws);
  const cid = decoded?.header?.cid;
  return typeof cid === 'string' ? cid : null;
}

function getPrevCid(jws: string): string | null {
  const decoded = decodeJwsUnsafe(jws);
  const prev = decoded?.payload?.['previousOperationCID'];
  return typeof prev === 'string' ? prev : null;
}

function getOpCreatedAt(jws: string): string | null {
  const decoded = decodeJwsUnsafe(jws);
  const t = decoded?.payload?.['createdAt'];
  return typeof t === 'string' ? t : null;
}

/**
 * Walk backward from targetCID to genesis, building an ordered array.
 * Returns null if targetCID is not reachable or a cycle is detected.
 */
function buildPathToCID(allOps: string[], targetCID: string): string[] | null {
  const cidToJws = new Map<string, string>();
  for (const jws of allOps) {
    const cid = getOpCid(jws);
    if (cid) cidToJws.set(cid, jws);
  }

  const path: string[] = [];
  let currentCID: string | null = targetCID;
  const visited = new Set<string>();

  while (currentCID !== null) {
    if (visited.has(currentCID)) return null; // cycle
    visited.add(currentCID);
    const jws = cidToJws.get(currentCID);
    if (!jws) return null; // not found in log
    path.unshift(jws); // prepend to build genesis→head order
    currentCID = getPrevCid(jws);
  }

  return path;
}

/**
 * Compute all tip CIDs — operations not referenced as previousOperationCID by any other op.
 */
function computeTips(allOps: string[]): string[] {
  const allCids = new Set<string>();
  const referencedCids = new Set<string>();

  for (const jws of allOps) {
    const cid = getOpCid(jws);
    if (cid) allCids.add(cid);
    const prev = getPrevCid(jws);
    if (prev) referencedCids.add(prev);
  }

  return Array.from(allCids).filter((cid) => !referencedCids.has(cid));
}

/**
 * Deterministic head selection: sort tips by (createdAt DESC, cid DESC), take [0].
 */
function selectDeterministicHead(allOps: string[], tips: string[]): string {
  if (tips.length === 1) return tips[0];

  const cidToCreatedAt = new Map<string, string>();
  for (const jws of allOps) {
    const cid = getOpCid(jws);
    const t = getOpCreatedAt(jws);
    if (cid && t) cidToCreatedAt.set(cid, t);
  }

  const sorted = Array.from(tips).sort((a, b) => {
    const timeA = cidToCreatedAt.get(a) ?? '';
    const timeB = cidToCreatedAt.get(b) ?? '';
    const timeCompare = timeB.localeCompare(timeA); // DESC
    if (timeCompare !== 0) return timeCompare;
    return b.localeCompare(a); // CID DESC as tiebreaker
  });

  return sorted[0];
}

// ─── Key resolver ─────────────────────────────────────────────────────────────

function createKeyResolver(store: RelayStore) {
  return async (kid: string): Promise<Uint8Array> => {
    const hashIdx = kid.indexOf('#');
    if (hashIdx < 0) throw new Error(`kid must be a DID URL: ${kid}`);
    const did = kid.substring(0, hashIdx);
    const keyId = kid.substring(hashIdx + 1);
    const identity = await store.getIdentityChain(did);
    if (!identity) throw new Error(`unknown identity: ${did}`);

    // Check current state keys first
    const currentKeys = [
      ...identity.state.authKeys,
      ...identity.state.assertKeys,
      ...identity.state.controllerKeys,
    ];
    const currentKey = currentKeys.find((k) => k.id === keyId);
    if (currentKey) return decodeMultikey(currentKey.publicKeyMultibase).keyBytes;

    // Fall back to historical keys in the full log
    for (const token of identity.log) {
      const decoded = decodeJwsUnsafe(token);
      if (!decoded) continue;
      const payload = decoded.payload;
      const opType = payload['type'];
      if (opType !== 'create' && opType !== 'update') continue;
      for (const arrayName of ['authKeys', 'assertKeys', 'controllerKeys'] as const) {
        const keys = payload[arrayName];
        if (!Array.isArray(keys)) continue;
        for (const k of keys) {
          if (
            k &&
            typeof k === 'object' &&
            'id' in k &&
            (k as Record<string, unknown>)['id'] === keyId &&
            'publicKeyMultibase' in k
          ) {
            return decodeMultikey((k as Record<string, unknown>)['publicKeyMultibase'] as string)
              .keyBytes;
          }
        }
      }
    }

    throw new Error(`unknown key ${keyId} on identity ${did}`);
  };
}

// ─── Identity op ingestion ────────────────────────────────────────────────────

async function ingestIdentityOp(
  jwsToken: string,
  store: RelayStore,
): Promise<IngestionResult060> {
  const decoded = decodeJwsUnsafe(jwsToken);
  if (!decoded) return { cid: '', status: 'rejected', error: 'failed to decode JWS' };

  const payload = decoded.payload;
  const encoded = await dagCborCanonicalEncode(payload);
  const cid = encoded.cid.toString();

  // Duplicate check (idempotent re-submission)
  const existing = await store.getOperation(cid);
  if (existing) {
    if (existing.jwsToken !== jwsToken) {
      return {
        cid,
        status: 'rejected',
        error: 'operation already exists with a different signature',
      };
    }
    return { cid, status: 'duplicate', kind: 'identity-op', chainId: existing.chainId };
  }

  // Temporal guard
  const createdAt = typeof payload['createdAt'] === 'string' ? payload['createdAt'] : null;
  if (!createdAt || !isWithinTemporalWindow(createdAt)) {
    return { cid, status: 'rejected', error: 'createdAt is too far in the future' };
  }

  const opType = payload['type'];

  if (opType === 'create') {
    // Genesis operation
    const identity = await verifyIdentityChain({ didPrefix: 'did:dfos', log: [jwsToken] });
    const chain: StoredIdentityChain = {
      did: identity.did,
      log: [jwsToken],
      headCID: cid,
      lastCreatedAt: createdAt,
      state: identity,
    };
    await store.putIdentityChain(chain);
    await store.putOperation({ cid, jwsToken, chainType: 'identity', chainId: identity.did });
    await store.appendToLog({ cid, jwsToken, kind: 'identity-op', chainId: identity.did });
    return { cid, status: 'new', kind: 'identity-op', chainId: identity.did };
  }

  // Extension (update or delete)
  const kid = decoded.header.kid;
  const hashIdx = kid.indexOf('#');
  if (hashIdx < 0) return { cid, status: 'rejected', error: 'non-genesis kid must be a DID URL' };
  const did = kid.substring(0, hashIdx);

  const chain = await store.getIdentityChain(did);
  if (!chain) return { cid, status: 'rejected', error: `unknown identity: ${did}` };

  const previousCID =
    typeof payload['previousOperationCID'] === 'string'
      ? payload['previousOperationCID']
      : null;
  if (!previousCID) return { cid, status: 'rejected', error: 'missing previousOperationCID' };

  let extResult: { state: VerifiedIdentity; operationCID: string; createdAt: string };

  if (previousCID === chain.headCID) {
    // Normal linear extension — O(1) verify against trusted head state
    extResult = await verifyIdentityExtensionFromTrustedState({
      currentState: chain.state,
      headCID: chain.headCID,
      lastCreatedAt: chain.lastCreatedAt,
      newOp: jwsToken,
    });
  } else {
    // Fork: previousCID is not the current head — check if it exists in the DAG
    const forkPath = buildPathToCID(chain.log, previousCID);
    if (!forkPath || forkPath.length === 0) {
      return { cid, status: 'rejected', error: `unknown previous operation: ${previousCID}` };
    }

    // Replay state at the fork point
    const forkState = await verifyIdentityChain({ didPrefix: 'did:dfos', log: forkPath });
    const forkLastCreatedAt = getOpCreatedAt(forkPath[forkPath.length - 1]);
    if (!forkLastCreatedAt) {
      return { cid, status: 'rejected', error: 'fork point has no createdAt' };
    }

    extResult = await verifyIdentityExtensionFromTrustedState({
      currentState: forkState,
      headCID: previousCID,
      lastCreatedAt: forkLastCreatedAt,
      newOp: jwsToken,
    });
  }

  // Add to DAG log and recompute deterministic head
  const newLog = [...chain.log, jwsToken];
  const tips = computeTips(newLog);
  const newHeadCID = selectDeterministicHead(newLog, tips);

  let newState: VerifiedIdentity;
  let newLastCreatedAt: string;

  if (newHeadCID === cid) {
    // New op is the new deterministic head
    newState = extResult.state;
    newLastCreatedAt = extResult.createdAt;
  } else if (newHeadCID === chain.headCID) {
    // Existing head still wins — fork was accepted but didn't change the head
    newState = chain.state;
    newLastCreatedAt = chain.lastCreatedAt;
  } else {
    // Head changed to a previously-existing tip — full replay needed
    const headPath = buildPathToCID(newLog, newHeadCID);
    if (headPath && headPath.length > 0) {
      newState = await verifyIdentityChain({ didPrefix: 'did:dfos', log: headPath });
      newLastCreatedAt = getOpCreatedAt(headPath[headPath.length - 1]) ?? extResult.createdAt;
    } else {
      newState = extResult.state;
      newLastCreatedAt = extResult.createdAt;
    }
  }

  await store.putIdentityChain({ did, log: newLog, headCID: newHeadCID, lastCreatedAt: newLastCreatedAt, state: newState });
  await store.putOperation({ cid, jwsToken, chainType: 'identity', chainId: did });
  await store.appendToLog({ cid, jwsToken, kind: 'identity-op', chainId: did });
  return { cid, status: 'new', kind: 'identity-op', chainId: did };
}

// ─── Content op ingestion ─────────────────────────────────────────────────────

async function ingestContentOp(jwsToken: string, store: RelayStore): Promise<IngestionResult060> {
  const decoded = decodeJwsUnsafe(jwsToken);
  if (!decoded) return { cid: '', status: 'rejected', error: 'failed to decode JWS' };

  const payload = decoded.payload;
  const encoded = await dagCborCanonicalEncode(payload);
  const cid = encoded.cid.toString();

  // Duplicate check
  const existing = await store.getOperation(cid);
  if (existing) {
    if (existing.jwsToken !== jwsToken) {
      return {
        cid,
        status: 'rejected',
        error: 'operation already exists with a different signature',
      };
    }
    return { cid, status: 'duplicate', kind: 'content-op', chainId: existing.chainId };
  }

  // Temporal guard
  const createdAt = typeof payload['createdAt'] === 'string' ? payload['createdAt'] : null;
  if (!createdAt || !isWithinTemporalWindow(createdAt)) {
    return { cid, status: 'rejected', error: 'createdAt is too far in the future' };
  }

  // Signer identity check
  const signerDID = typeof payload['did'] === 'string' ? payload['did'] : null;
  if (signerDID) {
    const signerIdentity = await store.getIdentityChain(signerDID);
    if (signerIdentity?.state.isDeleted) {
      return { cid, status: 'rejected', error: 'signer identity is deleted' };
    }
  }

  const resolveKey = createKeyResolver(store);
  const opType = payload['type'];

  if (opType === 'create') {
    // Genesis
    const content = await verifyContentChain({ log: [jwsToken], resolveKey, enforceAuthorization: true });
    const chain: StoredContentChain = {
      contentId: content.contentId,
      genesisCID: content.genesisCID,
      log: [jwsToken],
      lastCreatedAt: createdAt,
      state: content,
    };
    await store.putContentChain(chain);
    await store.putOperation({ cid, jwsToken, chainType: 'content', chainId: content.contentId });
    await store.appendToLog({ cid, jwsToken, kind: 'content-op', chainId: content.contentId });
    return { cid, status: 'new', kind: 'content-op', chainId: content.contentId };
  }

  // Extension
  const previousCID =
    typeof payload['previousOperationCID'] === 'string'
      ? payload['previousOperationCID']
      : null;
  if (!previousCID) return { cid, status: 'rejected', error: 'missing previousOperationCID' };

  const prevOp = await store.getOperation(previousCID);
  if (!prevOp) return { cid, status: 'rejected', error: `unknown previous operation: ${previousCID}` };
  if (prevOp.chainType !== 'content') {
    return { cid, status: 'rejected', error: 'previousOperationCID is not a content operation' };
  }

  const chain = await store.getContentChain(prevOp.chainId);
  if (!chain) return { cid, status: 'rejected', error: `content chain not found: ${prevOp.chainId}` };

  const creatorIdentity = await store.getIdentityChain(chain.state.creatorDID);
  if (creatorIdentity?.state.isDeleted) {
    return { cid, status: 'rejected', error: 'content creator identity is deleted' };
  }

  let extResult: { state: VerifiedContentChain; operationCID: string; createdAt: string };

  if (chain.state.headCID === previousCID) {
    // Normal linear extension
    extResult = await verifyContentExtensionFromTrustedState({
      currentState: chain.state,
      lastCreatedAt: chain.lastCreatedAt,
      newOp: jwsToken,
      resolveKey,
      enforceAuthorization: true,
    });
  } else {
    // Fork: previousCID is not the current head
    const forkPath = buildPathToCID(chain.log, previousCID);
    if (!forkPath || forkPath.length === 0) {
      return { cid, status: 'rejected', error: `unknown previous operation: ${previousCID}` };
    }

    const forkState = await verifyContentChain({ log: forkPath, resolveKey, enforceAuthorization: true });
    const forkLastCreatedAt = getOpCreatedAt(forkPath[forkPath.length - 1]);
    if (!forkLastCreatedAt) {
      return { cid, status: 'rejected', error: 'fork point has no createdAt' };
    }

    extResult = await verifyContentExtensionFromTrustedState({
      currentState: forkState,
      lastCreatedAt: forkLastCreatedAt,
      newOp: jwsToken,
      resolveKey,
      enforceAuthorization: true,
    });
  }

  // Add to DAG log and recompute deterministic head
  const newLog = [...chain.log, jwsToken];
  const tips = computeTips(newLog);
  const newHeadCID = selectDeterministicHead(newLog, tips);

  let newState: VerifiedContentChain;
  let newLastCreatedAt: string;

  if (newHeadCID === cid) {
    newState = extResult.state;
    newLastCreatedAt = extResult.createdAt;
  } else if (newHeadCID === chain.state.headCID) {
    newState = chain.state;
    newLastCreatedAt = chain.lastCreatedAt;
  } else {
    const headPath = buildPathToCID(newLog, newHeadCID);
    if (headPath && headPath.length > 0) {
      newState = await verifyContentChain({ log: headPath, resolveKey, enforceAuthorization: true });
      newLastCreatedAt = getOpCreatedAt(headPath[headPath.length - 1]) ?? extResult.createdAt;
    } else {
      newState = extResult.state;
      newLastCreatedAt = extResult.createdAt;
    }
  }

  await store.putContentChain({
    contentId: chain.contentId,
    genesisCID: chain.genesisCID,
    log: newLog,
    lastCreatedAt: newLastCreatedAt,
    state: newState,
  });
  await store.putOperation({ cid, jwsToken, chainType: 'content', chainId: chain.contentId });
  await store.appendToLog({ cid, jwsToken, kind: 'content-op', chainId: chain.contentId });
  return { cid, status: 'new', kind: 'content-op', chainId: chain.contentId };
}

// ─── Beacon ingestion ─────────────────────────────────────────────────────────

async function ingestBeacon(jwsToken: string, store: RelayStore): Promise<IngestionResult060> {
  const resolveKey = createKeyResolver(store);
  let verified: Awaited<ReturnType<typeof verifyBeacon>>;
  try {
    verified = await verifyBeacon({ jwsToken, resolveKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'verification failed';
    return { cid: '', status: 'rejected', error: message };
  }

  const did = verified.payload.did;
  const cid = verified.beaconCID;

  // Temporal guard
  if (!isWithinTemporalWindow(verified.payload.createdAt)) {
    return { cid, status: 'rejected', error: 'createdAt is too far in the future' };
  }

  const identity = await store.getIdentityChain(did);
  if (identity?.state.isDeleted) {
    return { cid, status: 'rejected', error: 'identity is deleted' };
  }

  const existingBeacon = await store.getBeacon(did);
  if (existingBeacon) {
    const existingTime = new Date(existingBeacon.state.payload.createdAt).getTime();
    const newTime = new Date(verified.payload.createdAt).getTime();
    if (newTime <= existingTime) {
      return { cid, status: 'duplicate', kind: 'beacon', chainId: did };
    }
  }

  await store.putBeacon({ did, jwsToken, beaconCID: cid, state: verified });
  await store.putOperation({ cid, jwsToken, chainType: 'beacon', chainId: did });
  await store.appendToLog({ cid, jwsToken, kind: 'beacon', chainId: did });
  return { cid, status: 'new', kind: 'beacon', chainId: did };
}

// ─── Countersign ingestion ────────────────────────────────────────────────────

async function ingestCountersign(
  jwsToken: string,
  store: RelayStore,
): Promise<IngestionResult060> {
  const resolveKey = createKeyResolver(store);
  let verified: Awaited<ReturnType<typeof verifyCountersignature>>;
  try {
    verified = await verifyCountersignature({ jwsToken, resolveKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'verification failed';
    return { cid: '', status: 'rejected', error: message };
  }

  const cid = verified.countersignCID;
  const { witnessDID, targetCID } = verified;

  // Temporal guard
  const decodedForTime = decodeJwsUnsafe(jwsToken);
  const createdAt = decodedForTime?.payload?.['createdAt'];
  if (typeof createdAt === 'string' && !isWithinTemporalWindow(createdAt)) {
    return { cid, status: 'rejected', error: 'createdAt is too far in the future' };
  }

  // Duplicate check
  const existing = await store.getOperation(cid);
  if (existing) {
    if (existing.jwsToken !== jwsToken) {
      return {
        cid,
        status: 'rejected',
        error: 'countersign already exists with a different signature',
      };
    }
    return { cid, status: 'duplicate', kind: 'countersign', chainId: targetCID };
  }

  const targetOp = await store.getOperation(targetCID);
  if (!targetOp) {
    return { cid, status: 'rejected', error: `unknown target operation: ${targetCID}` };
  }

  let targetAuthorDID: string | null = null;
  if (targetOp.chainType === 'identity') {
    targetAuthorDID = targetOp.chainId;
  } else {
    const targetDecoded = decodeJwsUnsafe(targetOp.jwsToken);
    if (targetDecoded) {
      const p = targetDecoded.payload;
      targetAuthorDID = typeof p['did'] === 'string' ? p['did'] : null;
    }
  }

  if (targetAuthorDID && witnessDID === targetAuthorDID) {
    return { cid, status: 'rejected', error: 'witness DID must differ from target author DID' };
  }

  const witnessIdentity = await store.getIdentityChain(witnessDID);
  if (witnessIdentity?.state.isDeleted) {
    return { cid, status: 'rejected', error: 'witness identity is deleted' };
  }

  // Per-witness deduplication
  const existingCountersigns = await store.getCountersignatures(targetCID);
  for (const csJws of existingCountersigns) {
    const csDecoded = decodeJwsUnsafe(csJws);
    if (!csDecoded) continue;
    if (csDecoded.payload['did'] === witnessDID) {
      return { cid, status: 'duplicate', kind: 'countersign', chainId: targetCID };
    }
  }

  await store.putOperation({ cid, jwsToken, chainType: 'countersign', chainId: targetCID });
  await store.addCountersignature(targetCID, jwsToken);
  await store.appendToLog({ cid, jwsToken, kind: 'countersign', chainId: targetCID });
  return { cid, status: 'new', kind: 'countersign', chainId: targetCID };
}

// ─── Artifact ingestion ───────────────────────────────────────────────────────

async function ingestArtifact(jwsToken: string, store: RelayStore): Promise<IngestionResult060> {
  const resolveKey = createKeyResolver(store);
  let verified: Awaited<ReturnType<typeof verifyArtifact>>;
  try {
    verified = await verifyArtifact({ jwsToken, resolveKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'verification failed';
    return { cid: '', status: 'rejected', error: message };
  }

  const cid = verified.artifactCID;
  const did = verified.payload.did;

  // Temporal guard
  if (!isWithinTemporalWindow(verified.payload.createdAt)) {
    return { cid, status: 'rejected', error: 'createdAt is too far in the future' };
  }

  // Duplicate check
  const existing = await store.getOperation(cid);
  if (existing) {
    if (existing.jwsToken !== jwsToken) {
      return {
        cid,
        status: 'rejected',
        error: 'artifact already exists with a different signature',
      };
    }
    return { cid, status: 'duplicate', kind: 'artifact', chainId: did };
  }

  const identity = await store.getIdentityChain(did);
  if (identity?.state.isDeleted) {
    return { cid, status: 'rejected', error: 'identity is deleted' };
  }

  await store.putOperation({ cid, jwsToken, chainType: 'artifact', chainId: did });
  await store.appendToLog({ cid, jwsToken, kind: 'artifact', chainId: did });
  return { cid, status: 'new', kind: 'artifact', chainId: did };
}

// ─── Classification & dependency sort ────────────────────────────────────────

type ClassifiedOp = {
  jwsToken: string;
  kind: OperationKind | 'unknown';
  priority: number;
  operationCID: string | null;
  previousCID: string | null;
  originalIndex: number;
};

function classify(jwsToken: string): Omit<ClassifiedOp, 'originalIndex'> {
  const unknown = {
    jwsToken,
    kind: 'unknown' as const,
    priority: 99,
    operationCID: null,
    previousCID: null,
  };

  const decoded = decodeJwsUnsafe(jwsToken);
  if (!decoded) return unknown;

  const typ = decoded.header.typ;
  const payload = decoded.payload;
  const operationCID = typeof decoded.header.cid === 'string' ? decoded.header.cid : null;
  const previousCID =
    typeof payload['previousOperationCID'] === 'string'
      ? payload['previousOperationCID']
      : null;
  const base = { jwsToken, operationCID, previousCID };

  if (typ === 'did:dfos:identity-op') {
    return { ...base, kind: 'identity-op', priority: 0 };
  }
  if (typ === 'did:dfos:content-op') {
    return { ...base, kind: 'content-op', priority: 2 };
  }
  if (typ === 'did:dfos:beacon') {
    return { ...base, kind: 'beacon', priority: 1, previousCID: null };
  }
  if (typ === 'did:dfos:countersign') {
    return { ...base, kind: 'countersign', priority: 3, previousCID: null };
  }
  if (typ === 'did:dfos:artifact') {
    return { ...base, kind: 'artifact', priority: 1, previousCID: null };
  }

  return unknown;
}

function topologicalSortBucket(ops: ClassifiedOp[]): ClassifiedOp[] {
  if (ops.length <= 1) return ops;

  const cidToOp = new Map<string, ClassifiedOp>();
  for (const op of ops) {
    if (op.operationCID) cidToOp.set(op.operationCID, op);
  }

  const inDegree = new Map<ClassifiedOp, number>();
  const dependents = new Map<string, ClassifiedOp[]>();

  for (const op of ops) {
    const depInBatch = op.previousCID !== null && cidToOp.has(op.previousCID);
    inDegree.set(op, depInBatch ? 1 : 0);
    if (depInBatch) {
      const list = dependents.get(op.previousCID!) ?? [];
      list.push(op);
      dependents.set(op.previousCID!, list);
    }
  }

  const queue = ops.filter((op) => inDegree.get(op) === 0);
  const sorted: ClassifiedOp[] = [];

  while (queue.length > 0) {
    const op = queue.shift()!;
    sorted.push(op);
    if (op.operationCID) {
      for (const dep of dependents.get(op.operationCID) ?? []) {
        const deg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, deg);
        if (deg === 0) queue.push(dep);
      }
    }
  }

  // Append any stragglers (cycles or missing deps)
  if (sorted.length < ops.length) {
    const placed = new Set(sorted);
    for (const op of ops) {
      if (!placed.has(op)) sorted.push(op);
    }
  }

  return sorted;
}

function dependencySort(ops: ClassifiedOp[]): ClassifiedOp[] {
  const buckets = new Map<number, ClassifiedOp[]>();
  for (const op of ops) {
    const bucket = buckets.get(op.priority) ?? [];
    bucket.push(op);
    buckets.set(op.priority, bucket);
  }

  const result: ClassifiedOp[] = [];
  const sortedPriorities = Array.from(buckets.keys()).sort((a, b) => a - b);

  for (const priority of sortedPriorities) {
    const bucket = buckets.get(priority)!;
    if ((priority === 0 || priority === 2) && bucket.length > 1) {
      result.push(...topologicalSortBucket(bucket));
    } else {
      result.push(...bucket);
    }
  }

  return result;
}

// ─── Single op dispatch ───────────────────────────────────────────────────────

async function dispatchOp(op: ClassifiedOp, store: RelayStore): Promise<IngestionResult060> {
  switch (op.kind) {
    case 'identity-op':
      return ingestIdentityOp(op.jwsToken, store);
    case 'content-op':
      return ingestContentOp(op.jwsToken, store);
    case 'beacon':
      return ingestBeacon(op.jwsToken, store);
    case 'countersign':
      return ingestCountersign(op.jwsToken, store);
    case 'artifact':
      return ingestArtifact(op.jwsToken, store);
    default:
      return { cid: op.operationCID ?? '', status: 'rejected', error: 'unrecognized operation type' };
  }
}

// ─── Sequencer loop ───────────────────────────────────────────────────────────

const MAX_SEQUENCER_ATTEMPTS = 10;

async function runSequencerLoop(store: RelayStore, sequencerStore: SequencerStore): Promise<void> {
  while (true) {
    const pending = await sequencerStore.getPendingOps();
    if (pending.length === 0) break;

    const classified: ClassifiedOp[] = pending.map((p, i) => ({
      ...classify(p.jwsToken),
      originalIndex: i,
    }));
    const sorted = dependencySort(classified);

    let madeProgress = false;

    for (const op of sorted) {
      const info = pending[op.originalIndex];

      if (info.attempts >= MAX_SEQUENCER_ATTEMPTS) {
        await sequencerStore.updatePendingStatus(
          info.cid,
          'rejected',
          `max retry attempts (${MAX_SEQUENCER_ATTEMPTS}) exceeded`,
        );
        madeProgress = true;
        continue;
      }

      let result: IngestionResult060;
      try {
        result = await dispatchOp(op, store);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unexpected error';
        result = { cid: info.cid, status: 'rejected', error: message };
      }

      if (result.status === 'new' || result.status === 'duplicate') {
        await sequencerStore.updatePendingStatus(info.cid, 'resolved');
        madeProgress = true;
      } else if (result.status === 'rejected') {
        if (result.error && isDependencyError(result.error)) {
          await sequencerStore.updatePendingStatus(info.cid, 'pending', result.error, true);
        } else {
          await sequencerStore.updatePendingStatus(info.cid, 'rejected', result.error);
          madeProgress = true;
        }
      }
    }

    if (!madeProgress) break;
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function ingestOperations060(
  tokens: string[],
  store: RelayStore,
  sequencerStore?: SequencerStore,
): Promise<IngestionResult060[]> {
  const classified: ClassifiedOp[] = tokens.map((token, i) => ({
    ...classify(token),
    originalIndex: i,
  }));
  const sorted = dependencySort(classified);

  // Store all ops as pending before acquiring the mutex (lock-free storage)
  if (sequencerStore) {
    for (const op of classified) {
      if (op.operationCID) {
        await sequencerStore.putPending(op.operationCID, op.jwsToken);
      }
    }
  }

  const indexedResults = await withMutex(async () => {
    const results: Array<{ index: number; result: IngestionResult060 }> = [];

    for (const op of sorted) {
      let result: IngestionResult060;
      try {
        result = await dispatchOp(op, store);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unexpected error';
        result = { cid: op.operationCID ?? '', status: 'rejected', error: message };
      }

      if (sequencerStore && op.operationCID) {
        if (result.status === 'new') {
          await sequencerStore.updatePendingStatus(op.operationCID, 'resolved');
        } else if (result.status === 'rejected') {
          if (result.error && isDependencyError(result.error)) {
            // Keep as pending — will be retried by sequencer loop
            await sequencerStore.updatePendingStatus(op.operationCID, 'pending', result.error, true);
            // Return 'new' to caller: op is accepted into the pending queue
            result = { ...result, status: 'new' };
          } else {
            await sequencerStore.updatePendingStatus(op.operationCID, 'rejected', result.error);
          }
        }
        // 'duplicate': no status change needed (already resolved or pending)
      }

      results.push({ index: op.originalIndex, result });
    }

    // Run sequencer loop to resolve pending ops (including any from prior batches)
    if (sequencerStore) {
      await runSequencerLoop(store, sequencerStore);
    }

    return results;
  });

  return indexedResults.sort((a, b) => a.index - b.index).map((r) => r.result);
}
