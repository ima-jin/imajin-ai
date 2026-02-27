import { eq, isNull, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export * from './schema';
export * from './types';

type DB = PostgresJsDatabase<typeof schema>;

/**
 * Resolve all members of a pod, including members from linked child pods (recursive).
 */
export async function resolvePodMembers(db: DB, podId: string, maxDepth = 3): Promise<Set<string>> {
  const dids = new Set<string>();
  const visited = new Set<string>();

  async function resolve(currentPodId: string, depth: number) {
    if (depth > maxDepth || visited.has(currentPodId)) return;
    visited.add(currentPodId);

    // Get direct members (not removed)
    const members = await db
      .select({ did: schema.podMembers.did })
      .from(schema.podMembers)
      .where(and(eq(schema.podMembers.podId, currentPodId), isNull(schema.podMembers.removedAt)));

    for (const m of members) {
      dids.add(m.did);
    }

    // Get linked child pods (not unlinked)
    const links = await db
      .select({ childPodId: schema.podLinks.childPodId })
      .from(schema.podLinks)
      .where(and(eq(schema.podLinks.parentPodId, currentPodId), isNull(schema.podLinks.unlinkedAt)));

    for (const link of links) {
      await resolve(link.childPodId, depth + 1);
    }
  }

  await resolve(podId, 0);
  return dids;
}

/**
 * BFS shortest path (in hops) between two DIDs through pod co-membership.
 * Returns -1 if no path found within maxHops.
 */
export async function trustDistance(db: DB, didA: string, didB: string, maxHops = 6): Promise<number> {
  if (didA === didB) return 0;

  // Build adjacency: get all active memberships
  const allMembers = await db
    .select({ podId: schema.podMembers.podId, did: schema.podMembers.did })
    .from(schema.podMembers)
    .where(isNull(schema.podMembers.removedAt));

  // Group DIDs by pod
  const podToDids = new Map<string, string[]>();
  const didToPods = new Map<string, string[]>();
  for (const row of allMembers) {
    if (!podToDids.has(row.podId)) podToDids.set(row.podId, []);
    podToDids.get(row.podId)!.push(row.did);
    if (!didToPods.has(row.did)) didToPods.set(row.did, []);
    didToPods.get(row.did)!.push(row.podId);
  }

  // BFS
  const visited = new Set<string>([didA]);
  let frontier = [didA];
  let hops = 0;

  while (frontier.length > 0 && hops < maxHops) {
    hops++;
    const next: string[] = [];
    for (const did of frontier) {
      const pods = didToPods.get(did) || [];
      for (const podId of pods) {
        const coMembers = podToDids.get(podId) || [];
        for (const co of coMembers) {
          if (co === didB) return hops;
          if (!visited.has(co)) {
            visited.add(co);
            next.push(co);
          }
        }
      }
    }
    frontier = next;
  }

  return -1;
}

/**
 * All DIDs within N hops of the given DID through pod co-membership.
 */
export async function trustRadius(db: DB, did: string, maxHops = 3): Promise<Set<string>> {
  const allMembers = await db
    .select({ podId: schema.podMembers.podId, did: schema.podMembers.did })
    .from(schema.podMembers)
    .where(isNull(schema.podMembers.removedAt));

  const podToDids = new Map<string, string[]>();
  const didToPods = new Map<string, string[]>();
  for (const row of allMembers) {
    if (!podToDids.has(row.podId)) podToDids.set(row.podId, []);
    podToDids.get(row.podId)!.push(row.did);
    if (!didToPods.has(row.did)) didToPods.set(row.did, []);
    didToPods.get(row.did)!.push(row.podId);
  }

  const visited = new Set<string>([did]);
  let frontier = [did];
  let hops = 0;

  while (frontier.length > 0 && hops < maxHops) {
    hops++;
    const next: string[] = [];
    for (const d of frontier) {
      const pods = didToPods.get(d) || [];
      for (const podId of pods) {
        const coMembers = podToDids.get(podId) || [];
        for (const co of coMembers) {
          if (!visited.has(co)) {
            visited.add(co);
            next.push(co);
          }
        }
      }
    }
    frontier = next;
  }

  return visited;
}
