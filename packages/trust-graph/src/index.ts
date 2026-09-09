import { eq, isNull, and } from 'drizzle-orm';
import type { AnyDatabase } from '@imajin/db';
import * as schema from './schema';

export * from './schema';
export * from './types';

type DB = AnyDatabase;

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

type PodAdjacency = {
  podToDids: Map<string, string[]>;
  didToPods: Map<string, string[]>;
};

/** Build the pod<->DID adjacency maps from all active (non-removed) pod memberships. */
async function buildPodAdjacency(db: DB): Promise<PodAdjacency> {
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
  return { podToDids, didToPods };
}

/** All DIDs that co-occupy at least one pod with `did`. */
function coMembersOf(did: string, { podToDids, didToPods }: PodAdjacency): string[] {
  const pods = didToPods.get(did) || [];
  const result: string[] = [];
  for (const podId of pods) {
    const coMembers = podToDids.get(podId) || [];
    for (const co of coMembers) result.push(co);
  }
  return result;
}

/** BFS from `start` through pod co-membership, returning the hop count at which `target` is first reached, or -1. */
function bfsHopsTo(start: string, target: string, maxHops: number, adjacency: PodAdjacency): number {
  const visited = new Set<string>([start]);
  let frontier = [start];
  let hops = 0;

  while (frontier.length > 0 && hops < maxHops) {
    hops++;
    const next: string[] = [];
    for (const did of frontier) {
      for (const co of coMembersOf(did, adjacency)) {
        if (co === target) return hops;
        if (!visited.has(co)) {
          visited.add(co);
          next.push(co);
        }
      }
    }
    frontier = next;
  }

  return -1;
}

/** BFS from `start` through pod co-membership, returning every DID reached within `maxHops`. */
function bfsReachableWithin(start: string, maxHops: number, adjacency: PodAdjacency): Set<string> {
  const visited = new Set<string>([start]);
  let frontier = [start];
  let hops = 0;

  while (frontier.length > 0 && hops < maxHops) {
    hops++;
    const next: string[] = [];
    for (const did of frontier) {
      for (const co of coMembersOf(did, adjacency)) {
        if (!visited.has(co)) {
          visited.add(co);
          next.push(co);
        }
      }
    }
    frontier = next;
  }

  return visited;
}

/**
 * BFS shortest path (in hops) between two DIDs through pod co-membership.
 * Returns -1 if no path found within maxHops.
 */
export async function trustDistance(db: DB, didA: string, didB: string, maxHops = 6): Promise<number> {
  if (didA === didB) return 0;
  const adjacency = await buildPodAdjacency(db);
  return bfsHopsTo(didA, didB, maxHops, adjacency);
}

/**
 * All DIDs within N hops of the given DID through pod co-membership.
 */
export async function trustRadius(db: DB, did: string, maxHops = 3): Promise<Set<string>> {
  const adjacency = await buildPodAdjacency(db);
  return bfsReachableWithin(did, maxHops, adjacency);
}
