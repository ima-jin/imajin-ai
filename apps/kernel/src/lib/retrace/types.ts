/**
 * Retrace (#1962): a read-only causal walk from any terminal artifact back
 * to the originating signed intent. Types shared by the parent-link
 * resolution layer (`repository.ts`), the per-hop authorization layer
 * (`authorize.ts`), and the walk orchestration (`walk.ts`).
 *
 * See `docs/agents/retrace-view.md` for the documented parent-link
 * resolution rule per artifact kind and the supported-kinds list.
 */
import type { DisclosureScope } from '@imajin/auth';

/** Artifact kinds retrace currently knows how to fetch and walk. */
export type ArtifactKind = 'attestation' | 'agent_provision' | 'bus_event';

/** A pointer to one artifact: what kind of row it is, and its id. */
export interface ArtifactRef {
  kind: ArtifactKind;
  id: string;
}

/** Who a hop's visibility is judged against — mirrors `DisclosureAudience` (disclosure-access.ts) plus a nullable scope for kinds that carry no disclosure_scope column of their own. */
export interface HopAudience {
  subjectDid: string;
  actorDid: string;
  delegatorDid: string | null;
  /** null when this artifact kind has no disclosure_scope concept — falls back to party/org-member-only visibility. */
  disclosureScope: DisclosureScope | null;
}

/** The grant/scope a hop's actor acted under, if any. */
export interface HopGrant {
  grantId: string;
  capability?: string;
}

export type HopSignatureStatus = 'verified' | 'invalid' | 'unsigned';

/**
 * One resolved artifact, fetched from storage: its own hop data, who may
 * read it, and the (already-resolved) parent it points to, if any.
 */
export interface HopRecord {
  ref: ArtifactRef;
  actorDid: string;
  onBehalfOf: string | null;
  grant: HopGrant | null;
  route: string;
  timestamp: string;
  signature: HopSignatureStatus;
  audience: HopAudience;
  parent: ArtifactRef | null;
  /** Set when `parent` is null, explaining why the walk stops here. */
  terminalReason: string | null;
}

/** One hop in the API response — the shape described by issue #1962. */
export interface RetraceHop {
  kind: ArtifactKind;
  actorDid: string;
  onBehalfOf: string | null;
  grant: HopGrant | null;
  input: string | null;
  output: string;
  route: string;
  timestamp: string;
  signature: HopSignatureStatus;
}

/** An opaque stand-in for a hop the caller isn't authorized to read — reveals THAT a hop exists, never WHAT. */
export interface RetraceTombstone {
  kind: 'tombstone';
  timestamp: string;
  hash: string;
}

export type RetraceNode = RetraceHop | RetraceTombstone;

export interface RetraceTerminal {
  reached: boolean;
  ref: ArtifactRef | null;
  reason: string | null;
}

export interface RetraceResult {
  hops: RetraceNode[];
  terminal: RetraceTerminal;
  truncated: boolean;
}

/** Storage + authorization seam the walk is written against, so `walk.ts` never touches the DB directly and is unit-testable with a fake. */
export interface RetraceRepository {
  fetch(ref: ArtifactRef): Promise<HopRecord | null>;
  canRead(viewerDid: string, audience: HopAudience): Promise<boolean>;
}

/** Cap on chain-walk hops (issue #1962: "~200"). Bounds fan-out regardless of the visited-set cycle guard. */
export const RETRACE_MAX_DEPTH = 200;
