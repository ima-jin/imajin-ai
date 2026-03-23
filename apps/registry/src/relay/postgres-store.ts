import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  RelayStore,
  StoredOperation,
  StoredIdentityChain,
  StoredContentChain,
  StoredBeacon,
  BlobKey,
} from '@metalabel/dfos-web-relay';
import { decodeJwsUnsafe } from '@metalabel/dfos-protocol';
import {
  relayOperations,
  relayIdentityChains,
  relayContentChains,
  relayBeacons,
  relayBlobs,
  relayCountersignatures,
} from '../db/relay-schema';

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
    };
  }

  async putIdentityChain(chain: StoredIdentityChain): Promise<void> {
    await this.db
      .insert(relayIdentityChains)
      .values({
        did: chain.did,
        log: chain.log,
        state: chain.state,
      })
      .onConflictDoUpdate({
        target: relayIdentityChains.did,
        set: {
          log: chain.log,
          state: chain.state,
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
      })
      .onConflictDoUpdate({
        target: relayContentChains.contentId,
        set: {
          log: chain.log,
          state: chain.state,
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
}
