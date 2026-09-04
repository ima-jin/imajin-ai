/**
 * Retrace (#1962) walk orchestration.
 *
 * Pure with respect to storage: everything DB-shaped lives behind
 * `RetraceRepository` (see `repository.ts` for the real implementation),
 * so this file only sequences hops, checks authorization, and applies the
 * cycle/depth guard. That keeps it unit-testable with a fake repository.
 */
import { createHash } from 'node:crypto';
import type { ArtifactRef, HopRecord, RetraceNode, RetraceRepository, RetraceResult } from './types';
import { RETRACE_MAX_DEPTH } from './types';

function refKey(ref: ArtifactRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** A stable, opaque identifier for a hop the caller can't read — reveals that a hop exists, never what it is. */
function hashRef(ref: ArtifactRef): string {
  return createHash('sha256').update(refKey(ref)).digest('hex');
}

function toVisibleHop(record: HopRecord): RetraceNode {
  return {
    kind: record.ref.kind,
    actorDid: record.actorDid,
    onBehalfOf: record.onBehalfOf,
    grant: record.grant,
    input: record.parent?.id ?? null,
    output: record.ref.id,
    route: record.route,
    timestamp: record.timestamp,
    signature: record.signature,
  };
}

function toTombstone(record: HopRecord): RetraceNode {
  return { kind: 'tombstone', timestamp: record.timestamp, hash: hashRef(record.ref) };
}

/**
 * Errors distinguishable from a plain "not found": the route layer maps
 * `NotFoundError` to 404 and `ForbiddenStartError` to 403 — the starting
 * artifact is the one hop retrace refuses to serve even as a tombstone,
 * since a caller who can't see their own starting point shouldn't learn
 * that *anything* exists there.
 */
export class RetraceNotFoundError extends Error {}
export class RetraceForbiddenStartError extends Error {}

/**
 * Walk backward from `startRef` to the originating signed intent (or the
 * first unresolved parent link), newest hop first.
 *
 * Throws `RetraceNotFoundError` if `startRef` doesn't resolve to a row, and
 * `RetraceForbiddenStartError` if the caller isn't authorized to read the
 * starting artifact at all.
 */
export async function walkRetrace(
  startRef: ArtifactRef,
  viewerDid: string,
  repo: RetraceRepository,
  maxDepth: number = RETRACE_MAX_DEPTH,
): Promise<RetraceResult> {
  const first = await repo.fetch(startRef);
  if (!first) throw new RetraceNotFoundError(`Artifact not found: ${refKey(startRef)}`);
  const canReadFirst = await repo.canRead(viewerDid, first.audience);
  if (!canReadFirst) {
    throw new RetraceForbiddenStartError(`Not authorized to retrace from ${refKey(startRef)}`);
  }

  const hops: RetraceNode[] = [];
  const visited = new Set<string>();
  let current: HopRecord | null = first;
  let currentCanRead: boolean = canReadFirst;
  let truncated = false;
  let terminal: RetraceResult['terminal'] = { reached: false, ref: null, reason: null };

  while (current) {
    const key = refKey(current.ref);
    if (visited.has(key)) {
      truncated = true;
      break;
    }
    visited.add(key);

    hops.push(currentCanRead ? toVisibleHop(current) : toTombstone(current));

    if (!current.parent) {
      terminal = { reached: true, ref: current.ref, reason: current.terminalReason };
      break;
    }
    if (visited.size >= maxDepth) {
      truncated = true;
      break;
    }

    const parentRecord: HopRecord | null = await repo.fetch(current.parent);
    if (!parentRecord) {
      terminal = { reached: true, ref: null, reason: `Parent artifact not found: ${refKey(current.parent)}` };
      break;
    }
    current = parentRecord;
    currentCanRead = await repo.canRead(viewerDid, current.audience);
  }

  return { hops, terminal, truncated };
}
