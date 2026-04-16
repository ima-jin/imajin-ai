import { eq, and, gt, sql, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  RelayStore,
  StoredOperation,
  StoredIdentityChain,
  StoredContentChain,
  StoredBeacon,
  BlobKey,
  LogEntry,
  OperationKind,
} from '@metalabel/dfos-web-relay';
import { createKeyResolver, createHistoricalIdentityResolver } from '@metalabel/dfos-web-relay';
import { decodeJwsUnsafe } from '@metalabel/dfos-protocol/crypto';
import { verifyIdentityChain, verifyContentChain } from '@metalabel/dfos-protocol/chain';
import {
  relayOperations,
  relayIdentityChains,
  relayContentChains,
  relayBeacons,
  relayBlobs,
  relayCountersignatures,
  relayOperationLog,
  relayPendingOperations,
  relayPeerCursors,
  relayRevocations,
  relayPublicCredentials,
} from '@/src/db/schemas/relay';

interface ReadLogResult {
  entries: LogEntry[];
  cursor: string | null;
}

export class PostgresRelayStore implements RelayStore {
  constructor(private readonly db: PostgresJsDatabase<Record<string, unknown>>) {}

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

  async getBeacon(did: string): Promise<StoredBeacon | undefined> {
    const rows = await this.db
      .select()
      .from(relayBeacons)
      .where(eq(relayBeacons.did, did));
    const row = rows[0];
    if (!row) return undefined;
    return {
      did: row.did,
      jwsToken: row.jwsToken,
      beaconCID: row.beaconCid,
      state: row.state as StoredBeacon['state'],
    };
  }

  async putBeacon(beacon: StoredBeacon): Promise<void> {
    await this.db
      .insert(relayBeacons)
      .values({
        did: beacon.did,
        jwsToken: beacon.jwsToken,
        beaconCid: beacon.beaconCID,
        state: beacon.state,
      })
      .onConflictDoUpdate({
        target: relayBeacons.did,
        set: {
          jwsToken: beacon.jwsToken,
          beaconCid: beacon.beaconCID,
          state: beacon.state,
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
    return row.data as unknown as Uint8Array;
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
    if (decoded) {
      const witnessDID = decoded.header.kid.split('#')[0];
      const existing = await this.getCountersignatures(operationCid);
      for (const existingJws of existing) {
        const existingDecoded = decodeJwsUnsafe(existingJws);
        if (existingDecoded && existingDecoded.header.kid.split('#')[0] === witnessDID) {
          return;
        }
      }
    }
    await this.db.insert(relayCountersignatures).values({
      operationCid,
      jwsToken,
    });
  }

  async appendToLog(entry: LogEntry): Promise<void> {
    await this.db.insert(relayOperationLog).values({
      cid: entry.cid,
      jwsToken: entry.jwsToken,
      kind: entry.kind,
      chainId: entry.chainId,
    });
  }

  async readLog(params: { after?: string; limit: number }): Promise<ReadLogResult> {
    let cursorSeq: bigint | null = null;
    let cursorNotFound = false;

    if (params.after) {
      const cursorRows = await this.db
        .select({ seq: relayOperationLog.seq })
        .from(relayOperationLog)
        .where(eq(relayOperationLog.cid, params.after));
      const cursorRow = cursorRows[0];
      if (cursorRow) {
        cursorSeq = cursorRow.seq as bigint;
      } else {
        // Unknown cursor: return empty page instead of falling back to beginning
        cursorNotFound = true;
      }
    }

    if (cursorNotFound) {
      return { entries: [], cursor: null };
    }

    const query = this.db
      .select()
      .from(relayOperationLog)
      .orderBy(relayOperationLog.seq)
      .limit(params.limit);

    const rows = cursorSeq !== null
      ? await query.where(gt(relayOperationLog.seq, cursorSeq))
      : await query;

    const entries: LogEntry[] = rows.map((row) => ({
      cid: row.cid,
      jwsToken: row.jwsToken,
      kind: row.kind as OperationKind,
      chainId: row.chainId,
    }));

    const cursor = entries.length === params.limit ? entries[entries.length - 1].cid : null;

    return { entries, cursor };
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

    const resolveKey = createKeyResolver(this);
    const resolveIdentity = createHistoricalIdentityResolver(this);
    const state = await verifyContentChain({ log: path, resolveKey, enforceAuthorization: true, resolveIdentity });

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

  async putRawOp(cid: string, jwsToken: string): Promise<void> {
    await this.db
      .insert(relayPendingOperations)
      .values({ cid, jwsToken, status: 'pending' })
      .onConflictDoNothing();
  }

  async getUnsequencedOps(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ jwsToken: relayPendingOperations.jwsToken })
      .from(relayPendingOperations)
      .where(eq(relayPendingOperations.status, 'pending'))
      .orderBy(relayPendingOperations.receivedAt)
      .limit(limit);
    return rows.map((r) => r.jwsToken);
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
      .select({ credentialCid: relayRevocations.credentialCid })
      .from(relayRevocations)
      .where(eq(relayRevocations.issuerDid, issuerDID));
    return rows.map((r) => r.credentialCid);
  }

  async addRevocation(revocation: { cid: string; issuerDID: string; credentialCID: string; jwsToken: string }): Promise<void> {
    await this.db
      .insert(relayRevocations)
      .values({
        cid: revocation.cid,
        issuerDid: revocation.issuerDID,
        credentialCid: revocation.credentialCID,
        jwsToken: revocation.jwsToken,
      })
      .onConflictDoNothing();
  }

  async isCredentialRevoked(issuerDID: string, credentialCID: string): Promise<boolean> {
    const rows = await this.db
      .select({ credentialCid: relayRevocations.credentialCid })
      .from(relayRevocations)
      .where(and(eq(relayRevocations.issuerDid, issuerDID), eq(relayRevocations.credentialCid, credentialCID)));
    return rows.length > 0;
  }

  async getPublicCredentials(resource: string): Promise<string[]> {
    const isChainRequest = resource.startsWith('chain:');
    const rows = await this.db
      .select({ jwsToken: relayPublicCredentials.jwsToken })
      .from(relayPublicCredentials)
      .where(
        isChainRequest
          ? sql`${relayPublicCredentials.att} @> ${JSON.stringify([{ resource }])}::jsonb
             OR ${relayPublicCredentials.att} @> '[{"resource":"chain:*"}]'::jsonb`
          : sql`${relayPublicCredentials.att} @> ${JSON.stringify([{ resource }])}::jsonb`,
      );
    return rows.map((r) => r.jwsToken).filter((t): t is string => t !== null);
  }

  async addPublicCredential(credential: { cid: string; issuerDID: string; att: { resource: string; action: string }[]; exp: number; jwsToken: string }): Promise<void> {
    await this.db
      .insert(relayPublicCredentials)
      .values({
        cid: credential.cid,
        issuerDid: credential.issuerDID,
        att: credential.att,
        exp: credential.exp,
        jwsToken: credential.jwsToken,
      })
      .onConflictDoNothing();
  }

  async removePublicCredential(credentialCID: string): Promise<void> {
    await this.db
      .delete(relayPublicCredentials)
      .where(eq(relayPublicCredentials.cid, credentialCID));
  }

  async getDocuments(
    contentId: string,
    params: { after?: string; limit: number },
  ): Promise<{ documents: { operationCID: string; documentCID: string | null; document: unknown | null; signerDID: string; createdAt: string }[]; cursor: string | null }> {
    const chain = await this.getContentChain(contentId);
    if (!chain) return { documents: [], cursor: null };

    // Derive document entries from the chain log (matches MemoryRelayStore behavior)
    const entries: Array<{ cid: string; documentCID: string | null; signerDID: string; createdAt: string }> = [];
    for (const jws of chain.log) {
      const decoded = decodeJwsUnsafe(jws);
      if (!decoded) continue;
      const payload = decoded.payload as Record<string, unknown>;
      const cid = typeof decoded.header.cid === 'string' ? decoded.header.cid : '';
      const documentCID = typeof payload['documentCID'] === 'string' ? payload['documentCID'] : null;
      const signerDID = typeof payload['did'] === 'string' ? payload['did'] : '';
      const createdAt = typeof payload['createdAt'] === 'string' ? payload['createdAt'] : '';
      entries.push({ cid, documentCID, signerDID, createdAt });
    }

    // Cursor is an operation CID — find its position and start after it
    let startIdx = 0;
    if (params.after) {
      const idx = entries.findIndex((e) => e.cid === params.after);
      startIdx = idx >= 0 ? idx + 1 : entries.length;
    }
    const page = entries.slice(startIdx, startIdx + params.limit);

    // Fetch blobs for entries that have a documentCID
    const documents = [];
    for (const entry of page) {
      let document: unknown = null;
      if (entry.documentCID) {
        const blob = await this.getBlob({
          creatorDID: chain.state.creatorDID,
          documentCID: entry.documentCID,
        });
        if (blob) {
          try {
            document = JSON.parse(new TextDecoder().decode(blob));
          } catch {
            document = null;
          }
        }
      }
      documents.push({
        operationCID: entry.cid,
        documentCID: entry.documentCID,
        document,
        signerDID: entry.signerDID,
        createdAt: entry.createdAt,
      });
    }

    const cursor = page.length === params.limit ? page[page.length - 1].cid : null;
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
