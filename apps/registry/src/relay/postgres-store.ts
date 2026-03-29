import { eq, and, gt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  RelayStore,
  StoredOperation,
  StoredIdentityChain,
  StoredContentChain,
  StoredBeacon,
  BlobKey,
  // TODO: import LogEntry and ReadLogResult from @metalabel/dfos-web-relay once 0.5.0 is installed
} from '@metalabel/dfos-web-relay';
import { decodeJwsUnsafe } from '@metalabel/dfos-protocol';
import {
  relayOperations,
  relayIdentityChains,
  relayContentChains,
  relayBeacons,
  relayBlobs,
  relayCountersignatures,
  relayOperationLog,
} from '../db/relay-schema';

// TODO: replace with imported types from @metalabel/dfos-web-relay once 0.5.0 is installed
type OperationKind = 'identity-op' | 'content-op' | 'beacon' | 'artifact' | 'countersign';
interface LogEntry {
  cid: string;
  jwsToken: string;
  kind: OperationKind;
  chainId: string;
}
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
      headCID: row.headCid ?? undefined,
      lastCreatedAt: row.lastCreatedAt?.toISOString() ?? undefined,
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
      lastCreatedAt: row.lastCreatedAt?.toISOString() ?? undefined,
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
}
