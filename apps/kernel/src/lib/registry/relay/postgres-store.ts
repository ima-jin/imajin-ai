import { eq, and, gt, sql, inArray, isNull, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  RelayStore,
  StoredOperation,
  StoredIdentityChain,
  StoredContentChain,
  BlobKey,
  LogEntry,
  OperationKind,
  CommitBatch,
  CommitResult,
  OperationCommit,
  RelayWriteStore,
  RelayWriterState,
  RelayStats,
  StoredRevocation,
} from '@metalabel/dfos-web-relay';
import { createAsOfKeyResolver, createIdentityResolver } from '@metalabel/dfos-web-relay';
import { decodeJwsUnsafe } from '@metalabel/dfos-protocol/crypto';
import { verifyIdentityChain, verifyContentChain, parseProtocolTimestampUnix } from '@metalabel/dfos-protocol/chain';
import {
  relayOperations,
  relayIdentityChains,
  relayContentChains,
  relayBlobs,
  relayCountersignatures,
  relayOperationLog,
  relayPendingOperations,
  relayPeerCursors,
  relayRevocations,
  relayPublicCredentials,
} from '@/src/db/schemas/relay';
import { mapWithConcurrency } from '@/src/lib/async/sequential';

/** Max document blob reads in flight while assembling one `getDocuments` page. */
const DOCUMENT_BLOB_READ_CONCURRENCY = 5;

type StoredPublicCredential = NonNullable<Awaited<ReturnType<RelayStore['getPublicCredentialByCID']>>>;
type OpOrigin = NonNullable<Parameters<RelayWriterState['putRawOp']>[2]>;
type PendingOp = Awaited<ReturnType<RelayWriterState['getUnsequencedOps']>>[number];

interface ReadLogResult {
  entries: LogEntry[];
  next: string | null;
}

interface DocumentLogEntry {
  cid: string;
  documentCID: string | null;
  signerDID: string;
  createdAt: string;
}

function decodeDocumentLogEntry(jws: string): DocumentLogEntry | null {
  const decoded = decodeJwsUnsafe(jws);
  if (!decoded) return null;
  const payload = decoded.payload as Record<string, unknown>;
  return {
    cid: typeof decoded.header.cid === 'string' ? decoded.header.cid : '',
    documentCID: typeof payload['documentCID'] === 'string' ? payload['documentCID'] : null,
    signerDID: typeof payload['did'] === 'string' ? payload['did'] : '',
    createdAt: typeof payload['createdAt'] === 'string' ? payload['createdAt'] : '',
  };
}

// Derive document entries from a chain log (matches MemoryRelayStore behavior)
function buildDocumentEntries(log: string[]): DocumentLogEntry[] {
  const entries: DocumentLogEntry[] = [];
  for (const jws of log) {
    const entry = decodeDocumentLogEntry(jws);
    if (entry) entries.push(entry);
  }
  return entries;
}

// Cursor is an operation CID — find its position and start after it
function resolveDocumentsStartIndex(entries: DocumentLogEntry[], after: string | undefined): number {
  if (!after) return 0;
  const idx = entries.findIndex((e) => e.cid === after);
  return idx >= 0 ? idx + 1 : entries.length;
}

function parseDocumentBlob(blob: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(blob));
  } catch {
    return null;
  }
}

function storedRevocation(row: typeof relayRevocations.$inferSelect): StoredRevocation {
  return {
    cid: row.cid,
    issuerDID: row.issuerDid,
    credentialCID: row.credentialCid,
    jwsToken: row.jwsToken,
    createdAt: row.signedCreatedAt ?? '',
  };
}

function validateOperationCommit(batch: OperationCommit): void {
  if (batch.logEntry && batch.logEntry.cid !== batch.operation.cid) {
    throw new Error('commit: log entry does not describe the committed operation');
  }
  if (batch.identityChain && batch.contentChain) {
    throw new Error('commit: one operation extends one chain, not two');
  }
  const removal = batch.removePublicCredential;
  if (removal && (!batch.revocation || batch.revocation.issuerDID !== removal.issuerDID
    || batch.revocation.credentialCID !== removal.credentialCID)) {
    throw new Error('commit: credential removal requires its issuer-signed revocation');
  }
}

export class PostgresRelayStore implements RelayStore, RelayWriteStore, RelayWriterState {
  constructor(private readonly db: PostgresJsDatabase<Record<string, unknown>>) {}

  async commit(batch: CommitBatch): Promise<CommitResult> {
    return await this.db.transaction(async (tx) => {
      const store = new PostgresRelayStore(tx as unknown as PostgresJsDatabase<Record<string, unknown>>);
      if (batch.kind === 'blob') {
        await store.putBlob(batch.key, batch.bytes);
        return 'new';
      }
      validateOperationCommit(batch);
      const inserted = await tx.insert(relayOperations).values(batch.operation)
        .onConflictDoNothing().returning({ cid: relayOperations.cid });
      if (inserted.length === 0) return 'duplicate';
      if (batch.identityChain) await store.putIdentityChain(batch.identityChain);
      if (batch.contentChain) await store.putContentChain(batch.contentChain);
      if (batch.countersignature) {
        await store.addCountersignature(batch.countersignature.targetCID, batch.countersignature.jwsToken);
      }
      if (batch.revocation) await store.addRevocation(batch.revocation);
      if (batch.publicCredential) await store.addPublicCredential(batch.publicCredential);
      if (batch.removePublicCredential) {
        const { issuerDID, credentialCID } = batch.removePublicCredential;
        await tx.update(relayPublicCredentials).set({ revokedBy: batch.revocation!.cid })
          .where(and(eq(relayPublicCredentials.cid, credentialCID), eq(relayPublicCredentials.issuerDid, issuerDID)));
      }
      if (batch.logEntry) await store.appendToLog(batch.logEntry);
      return 'new';
    });
  }

  async getOperation(cid: string): Promise<StoredOperation | undefined> {
    const rows = await this.db
      .select()
      .from(relayOperations)
      .where(eq(relayOperations.cid, cid));
    const row = rows[0];
    if (!row) return undefined;
    return {
      cid: row.cid,
      jwsToken: row.jwsToken,
      chainType: row.chainType as StoredOperation['chainType'],
      chainId: row.chainId,
    };
  }

  async getStats(): Promise<RelayStats> {
    const counts = await this.db.select({ kind: relayOperationLog.kind, count: sql<string>`count(*)` })
      .from(relayOperationLog).groupBy(relayOperationLog.kind);
    const countsByKind: RelayStats['countsByKind'] = {
      identity: 0, content: 0, artifact: 0, credential: 0, countersign: 0, revocation: 0,
    };
    for (const row of counts) {
      let kind = row.kind;
      if (kind === 'identity-op') kind = 'identity';
      if (kind === 'content-op') kind = 'content';
      if (Object.hasOwn(countsByKind, kind)) countsByKind[kind as keyof typeof countsByKind] = Number(row.count);
    }
    const first = await this.db.select().from(relayOperationLog).orderBy(relayOperationLog.seq).limit(1);
    const last = await this.db.select({ cid: relayOperationLog.cid }).from(relayOperationLog)
      .orderBy(desc(relayOperationLog.seq)).limit(1);
    const createdAt = first[0] ? decodeJwsUnsafe(first[0].jwsToken)?.payload?.createdAt : null;
    return {
      opCount: Object.values(countsByKind).reduce((sum, count) => sum + count, 0),
      countsByKind,
      oldestOpAt: typeof createdAt === 'string' ? createdAt : null,
      headCid: last[0]?.cid ?? null,
    };
  }

  async putOperation(op: StoredOperation): Promise<void> {
    await this.db
      .insert(relayOperations)
      .values({
        cid: op.cid,
        jwsToken: op.jwsToken,
        chainType: op.chainType,
        chainId: op.chainId,
      })
      .onConflictDoNothing();
  }

  async getIdentityChain(did: string): Promise<StoredIdentityChain | undefined> {
    const rows = await this.db
      .select()
      .from(relayIdentityChains)
      .where(eq(relayIdentityChains.did, did));
    const row = rows[0];
    if (!row) return undefined;
    return {
      did: row.did,
      log: row.log as string[],
      state: row.state as StoredIdentityChain['state'],
      headCID: row.headCid ?? '',
      lastCreatedAt: row.lastCreatedAt?.toISOString() ?? '',
    };
  }

  async putIdentityChain(chain: StoredIdentityChain): Promise<void> {
    await this.db
      .insert(relayIdentityChains)
      .values({
        did: chain.did,
        log: chain.log,
        state: chain.state,
        headCid: chain.headCID ?? null,
        lastCreatedAt: chain.lastCreatedAt ? new Date(chain.lastCreatedAt) : null,
      })
      .onConflictDoUpdate({
        target: relayIdentityChains.did,
        set: {
          log: chain.log,
          state: chain.state,
          headCid: chain.headCID ?? null,
          lastCreatedAt: chain.lastCreatedAt ? new Date(chain.lastCreatedAt) : null,
          updatedAt: new Date(),
        },
      });
  }

  async getContentChain(contentId: string): Promise<StoredContentChain | undefined> {
    const rows = await this.db
      .select()
      .from(relayContentChains)
      .where(eq(relayContentChains.contentId, contentId));
    const row = rows[0];
    if (!row) return undefined;
    return {
      contentId: row.contentId,
      genesisCID: row.genesisCid,
      log: row.log as string[],
      state: row.state as StoredContentChain['state'],
      lastCreatedAt: row.lastCreatedAt?.toISOString() ?? '',
    };
  }

  async putContentChain(chain: StoredContentChain): Promise<void> {
    await this.db
      .insert(relayContentChains)
      .values({
        contentId: chain.contentId,
        genesisCid: chain.genesisCID,
        log: chain.log,
        state: chain.state,
        lastCreatedAt: chain.lastCreatedAt ? new Date(chain.lastCreatedAt) : null,
      })
      .onConflictDoUpdate({
        target: relayContentChains.contentId,
        set: {
          log: chain.log,
          state: chain.state,
          lastCreatedAt: chain.lastCreatedAt ? new Date(chain.lastCreatedAt) : null,
          updatedAt: new Date(),
        },
      });
  }

  async getBlob(key: BlobKey): Promise<Uint8Array | undefined> {
    const rows = await this.db
      .select()
      .from(relayBlobs)
      .where(
        and(
          eq(relayBlobs.creatorDid, key.creatorDID),
          eq(relayBlobs.documentCid, key.documentCID),
        ),
      );
    const row = rows[0];
    if (!row) return undefined;
    return row.data;
  }

  async putBlob(key: BlobKey, data: Uint8Array): Promise<void> {
    await this.db
      .insert(relayBlobs)
      .values({
        creatorDid: key.creatorDID,
        documentCid: key.documentCID,
        data: Buffer.from(data),
      })
      .onConflictDoNothing();
  }

  async getCountersignatures(operationCid: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(relayCountersignatures)
      .where(eq(relayCountersignatures.operationCid, operationCid));
    return rows.map((r) => r.jwsToken);
  }

  async addCountersignature(operationCid: string, jwsToken: string): Promise<void> {
    const decoded = decodeJwsUnsafe(jwsToken);
    const witnessDid = decoded?.header.kid?.split('#')[0] ?? null;

    await this.db.insert(relayCountersignatures).values({
      operationCid,
      jwsToken,
      witnessDid,
    }).onConflictDoNothing();
  }

  async appendToLog(entry: LogEntry): Promise<void> {
    await this.db.insert(relayOperationLog).values({
      cid: entry.cid,
      jwsToken: entry.jwsToken,
      kind: entry.kind,
      chainId: entry.chainId,
      ingestedAt: entry.ingestedAt,
    }).onConflictDoNothing();
  }

  async readLog(params: { after?: string; limit: number }): Promise<ReadLogResult | null> {
    let cursorSeq: bigint | null = null;
    let cursorNotFound = false;

    if (params.after) {
      const cursorRows = await this.db
        .select({ seq: relayOperationLog.seq })
        .from(relayOperationLog)
        .where(eq(relayOperationLog.cid, params.after))
        .orderBy(sql`${relayOperationLog.seq} DESC`)
        .limit(1);
      const cursorRow = cursorRows[0];
      if (cursorRow) {
        cursorSeq = cursorRow.seq as bigint;
      } else {
        // Cursors are relay-local; unknown positions must not look caught up.
        cursorNotFound = true;
      }
    }

    if (cursorNotFound) {
      return null;
    }

    const query = this.db
      .select()
      .from(relayOperationLog)
      .orderBy(relayOperationLog.seq)
      .limit(params.limit);

    const rows = cursorSeq === null
      ? await query
      : await query.where(gt(relayOperationLog.seq, cursorSeq));

    const entries: LogEntry[] = rows.map((row) => ({
      cid: row.cid,
      jwsToken: row.jwsToken,
      kind: row.kind as OperationKind,
      chainId: row.chainId,
      ingestedAt: row.ingestedAt,
    }));

    const lastEntry = entries.at(-1);
    const next = entries.length === params.limit && lastEntry ? lastEntry.cid : null;

    return { entries, next };
  }

  async getIdentityStateAtCID(
    did: string,
    cid: string,
  ): Promise<{ state: StoredIdentityChain['state']; lastCreatedAt: string } | null> {
    const chain = await this.getIdentityChain(did);
    if (!chain) return null;

    // build CID → { jws, previousCID } map from log
    const opsByCID = new Map<string, { jws: string; previousCID: string | null }>();
    for (const jws of chain.log) {
      const decoded = decodeJwsUnsafe(jws);
      if (!decoded) continue;
      const payload = decoded.payload as Record<string, unknown>;
      const opCID = typeof decoded.header.cid === 'string' ? decoded.header.cid : '';
      const prevCID =
        typeof payload['previousOperationCID'] === 'string'
          ? payload['previousOperationCID']
          : null;
      opsByCID.set(opCID, { jws, previousCID: prevCID });
    }

    if (!opsByCID.has(cid)) return null;

    // walk backward from target CID to genesis
    const path: string[] = [];
    let currentCID: string | null = cid;
    while (currentCID) {
      const op = opsByCID.get(currentCID);
      if (!op) return null;
      path.unshift(op.jws);
      currentCID = op.previousCID;
    }

    const state = await verifyIdentityChain({ didPrefix: 'did:dfos', log: path });

    const targetDecoded = decodeJwsUnsafe(opsByCID.get(cid)!.jws);
    const lastCreatedAt =
      typeof (targetDecoded?.payload as Record<string, unknown>)?.['createdAt'] === 'string'
        ? ((targetDecoded?.payload as Record<string, unknown>)['createdAt'] as string)
        : '';

    return { state, lastCreatedAt };
  }

  async getContentStateAtCID(
    contentId: string,
    cid: string,
  ): Promise<{ state: StoredContentChain['state']; lastCreatedAt: string } | null> {
    const chain = await this.getContentChain(contentId);
    if (!chain) return null;

    // build CID → { jws, previousCID } map from log
    const opsByCID = new Map<string, { jws: string; previousCID: string | null }>();
    for (const jws of chain.log) {
      const decoded = decodeJwsUnsafe(jws);
      if (!decoded) continue;
      const payload = decoded.payload as Record<string, unknown>;
      const opCID = typeof decoded.header.cid === 'string' ? decoded.header.cid : '';
      const prevCID =
        typeof payload['previousOperationCID'] === 'string'
          ? payload['previousOperationCID']
          : null;
      opsByCID.set(opCID, { jws, previousCID: prevCID });
    }

    if (!opsByCID.has(cid)) return null;

    // walk backward from target CID to genesis
    const path: string[] = [];
    let currentCID: string | null = cid;
    while (currentCID) {
      const op = opsByCID.get(currentCID);
      if (!op) return null;
      path.unshift(op.jws);
      currentCID = op.previousCID;
    }

    const resolveKey = createAsOfKeyResolver(this);
    const resolveIdentity = createIdentityResolver(this);
    const state = await verifyContentChain({
      log: path, resolveKey, enforceAuthorization: true, resolveIdentity,
      isRevoked: (issuerDID, credentialCID, asOfUnix) => this.isCredentialRevoked(issuerDID, credentialCID, asOfUnix),
    });

    const targetDecoded = decodeJwsUnsafe(opsByCID.get(cid)!.jws);
    const lastCreatedAt =
      typeof (targetDecoded?.payload as Record<string, unknown>)?.['createdAt'] === 'string'
        ? ((targetDecoded?.payload as Record<string, unknown>)['createdAt'] as string)
        : '';

    return { state, lastCreatedAt };
  }

  async getPeerCursor(peerUrl: string): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(relayPeerCursors)
      .where(eq(relayPeerCursors.peerUrl, peerUrl));
    return rows[0]?.cursor ?? undefined;
  }

  async setPeerCursor(peerUrl: string, cursor: string): Promise<void> {
    await this.db
      .insert(relayPeerCursors)
      .values({ peerUrl, cursor, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: relayPeerCursors.peerUrl,
        set: { cursor, updatedAt: new Date() },
      });
  }

  async putRawOp(cid: string, jwsToken: string, origin: OpOrigin = 'direct'): Promise<void> {
    await this.db
      .insert(relayPendingOperations)
      .values({ cid, jwsToken, origin, status: 'pending' })
      .onConflictDoNothing();
  }

  async getUnsequencedOps(after: string, limit: number): Promise<PendingOp[]> {
    const rows = await this.db
      .select()
      .from(relayPendingOperations)
      .where(and(
        eq(relayPendingOperations.status, 'pending'),
        after ? gt(relayPendingOperations.cid, after) : undefined,
      ))
      .orderBy(relayPendingOperations.cid)
      .limit(limit);
    return rows.map((r) => ({
      jwsToken: r.jwsToken,
      origin: r.origin as OpOrigin,
      cursor: r.cid,
    }));
  }

  async markOpsSequenced(cids: string[]): Promise<void> {
    if (cids.length === 0) return;
    await this.db
      .update(relayPendingOperations)
      .set({ status: 'sequenced' })
      .where(inArray(relayPendingOperations.cid, cids));
  }

  async markOpRejected(cid: string, reason: string): Promise<void> {
    await this.db
      .update(relayPendingOperations)
      .set({ status: 'rejected', lastError: reason })
      .where(eq(relayPendingOperations.cid, cid));
  }

  async countUnsequenced(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(relayPendingOperations)
      .where(eq(relayPendingOperations.status, 'pending'));
    return Number(rows[0]?.count ?? 0);
  }

  async resetSequencer(): Promise<void> {
    await this.db
      .update(relayPendingOperations)
      .set({ status: 'pending' })
      .where(sql`${relayPendingOperations.status} != 'rejected'`);
  }

  async getRevocations(issuerDID: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(relayRevocations)
      .where(eq(relayRevocations.issuerDid, issuerDID));
    return rows.map((r) => r.credentialCid);
  }

  async addRevocation(revocation: StoredRevocation): Promise<void> {
    const boundary = parseProtocolTimestampUnix(revocation.createdAt);
    const signedCreatedAt = boundary === null ? null : revocation.createdAt;
    await this.db
      .insert(relayRevocations)
      .values({
        cid: revocation.cid,
        issuerDid: revocation.issuerDID,
        credentialCid: revocation.credentialCID,
        jwsToken: revocation.jwsToken,
        signedCreatedAt,
      })
      .onConflictDoUpdate({
        target: [relayRevocations.issuerDid, relayRevocations.credentialCid],
        set: { cid: revocation.cid, jwsToken: revocation.jwsToken, signedCreatedAt },
        setWhere: sql`(
          COALESCE(${boundary}::double precision, '-Infinity'::double precision),
          ${revocation.cid} COLLATE "C"
        ) < (
          COALESCE(floor(extract(epoch FROM ${relayRevocations.signedCreatedAt}::timestamptz)), '-Infinity'::double precision),
          ${relayRevocations.cid} COLLATE "C"
        )`,
      });
  }

  async getRevocation(issuerDID: string, credentialCID: string): Promise<StoredRevocation | undefined> {
    const rows = await this.db
      .select()
      .from(relayRevocations)
      .where(and(eq(relayRevocations.issuerDid, issuerDID), eq(relayRevocations.credentialCid, credentialCID)));
    return rows[0] ? storedRevocation(rows[0]) : undefined;
  }

  async getRevocationForCredential(credentialCID: string): Promise<StoredRevocation | undefined> {
    const rows = await this.db.select().from(relayRevocations)
      .where(eq(relayRevocations.credentialCid, credentialCID))
      .orderBy(sql`${relayRevocations.issuerDid} COLLATE "C"`).limit(1);
    return rows[0] ? storedRevocation(rows[0]) : undefined;
  }

  async getRevocationsByIssuer(issuerDID: string): Promise<StoredRevocation[]> {
    const rows = await this.db.select().from(relayRevocations)
      .where(eq(relayRevocations.issuerDid, issuerDID))
      .orderBy(sql`${relayRevocations.credentialCid} COLLATE "C"`);
    return rows.map(storedRevocation);
  }

  async isCredentialRevoked(issuerDID: string, credentialCID: string, asOfUnix?: number): Promise<boolean> {
    const revocation = await this.getRevocation(issuerDID, credentialCID);
    if (!revocation) return false;
    if (asOfUnix === undefined || asOfUnix <= 0) return true;
    const boundary = parseProtocolTimestampUnix(revocation.createdAt);
    return boundary === null || boundary <= asOfUnix;
  }

  async getPublicCredentials(resource: string): Promise<string[]> {
    const isChainRequest = resource.startsWith('chain:');
    const rows = await this.db
      .select({ jwsToken: relayPublicCredentials.jwsToken })
      .from(relayPublicCredentials)
      .where(and(
        isNull(relayPublicCredentials.revokedBy),
        isChainRequest
          ? sql`(${relayPublicCredentials.att} @> ${JSON.stringify([{ resource }])}::jsonb
             OR ${relayPublicCredentials.att} @> '[{"resource":"chain:*"}]'::jsonb)`
          : sql`${relayPublicCredentials.att} @> ${JSON.stringify([{ resource }])}::jsonb`,
      ));
    return rows.map((r) => r.jwsToken).filter((t): t is string => t !== null);
  }

  async getPublicCredentialByCID(cid: string): Promise<StoredPublicCredential | undefined> {
    const rows = await this.db.select().from(relayPublicCredentials)
      .where(and(eq(relayPublicCredentials.cid, cid), isNull(relayPublicCredentials.revokedBy)));
    const row = rows[0];
    if (!row) return undefined;
    if (!row.issuerDid || !row.jwsToken || row.exp === null || !Array.isArray(row.att)) {
      throw new Error('Incomplete stored public credential');
    }
    return {
      cid: row.cid, issuerDID: row.issuerDid, att: row.att as StoredPublicCredential['att'],
      exp: row.exp, jwsToken: row.jwsToken, createdAt: row.signedCreatedAt, ingestedAt: row.ingestedAt,
    };
  }

  async addPublicCredential(credential: StoredPublicCredential): Promise<void> {
    await this.db
      .insert(relayPublicCredentials)
      .values({
        cid: credential.cid,
        issuerDid: credential.issuerDID,
        att: credential.att,
        exp: credential.exp,
        jwsToken: credential.jwsToken,
        signedCreatedAt: credential.createdAt,
        ingestedAt: credential.ingestedAt,
      })
      .onConflictDoNothing();
  }

  private async resolveDocumentForEntry(
    entry: DocumentLogEntry,
    creatorDID: string,
  ): Promise<unknown> {
    if (!entry.documentCID) return null;
    const blob = await this.getBlob({ creatorDID, documentCID: entry.documentCID });
    return blob ? parseDocumentBlob(blob) : null;
  }

  async getDocuments(
    contentId: string,
    params: { after?: string; limit: number },
  ): Promise<{ documents: { operationCID: string; documentCID: string | null; document: unknown; signerDID: string; createdAt: string }[]; cursor: string | null }> {
    const chain = await this.getContentChain(contentId);
    if (!chain) return { documents: [], cursor: null };

    // Derive document entries from the chain log (matches MemoryRelayStore behavior)
    const entries = buildDocumentEntries(chain.log);

    // Cursor is an operation CID — find its position and start after it
    const startIdx = resolveDocumentsStartIndex(entries, params.after);
    const page = entries.slice(startIdx, startIdx + params.limit);

    // Fetch blobs for entries that have a documentCID
    // Independent blob reads: fetch a few at a time; results keep the page's order.
    const documents = await mapWithConcurrency(page, DOCUMENT_BLOB_READ_CONCURRENCY, async (entry) => ({
      operationCID: entry.cid,
      documentCID: entry.documentCID,
      document: await this.resolveDocumentForEntry(entry, chain.state.creatorDID),
      signerDID: entry.signerDID,
      createdAt: entry.createdAt,
    }));

    const lastPage = page.at(-1);
    const cursor = page.length === params.limit && lastPage ? lastPage.cid : null;
    return { documents, cursor };
  }

  // --- legacy sequencer interface (kept for backwards compatibility) ---

  async putPending(cid: string, jwsToken: string): Promise<void> {
    return this.putRawOp(cid, jwsToken);
  }

  async getPendingOps(): Promise<Array<{ cid: string; jwsToken: string; attempts: number }>> {
    const rows = await this.db
      .select()
      .from(relayPendingOperations)
      .where(eq(relayPendingOperations.status, 'pending'))
      .orderBy(relayPendingOperations.receivedAt);
    return rows.map((r) => ({ cid: r.cid, jwsToken: r.jwsToken, attempts: r.attempts }));
  }

  async updatePendingStatus(
    cid: string,
    status: 'pending' | 'resolved' | 'rejected',
    error?: string,
    incrementAttempts?: boolean,
  ): Promise<void> {
    await this.db
      .update(relayPendingOperations)
      .set({
        status,
        lastError: error ?? null,
        ...(incrementAttempts
          ? { attempts: sql`${relayPendingOperations.attempts} + 1` }
          : {}),
      })
      .where(eq(relayPendingOperations.cid, cid));
  }
}
