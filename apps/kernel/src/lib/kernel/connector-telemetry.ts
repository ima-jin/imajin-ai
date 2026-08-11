/**
 * Per-DID, per-connector-scope telemetry rollup (#1799).
 *
 * A QUERY PATTERN over records the kernel has already signed — attestations
 * and signed connector actions — scoped to a connector's registered scope(s).
 * This is deliberately NOT a new ingestion pipeline (that is the sibling
 * issue #1677, which covers *external* tool usage reports): every row this
 * module reads already exists because something else in the kernel wrote it
 * as part of doing its job.
 *
 * Sources rolled up today:
 *
 *   - `auth.attestations`, filtered to `contextType = connector.channel`. Any
 *     bus event can be turned into a signed attestation by configuring the
 *     generic `attestationReactor` (packages/bus/src/reactors/attestation.ts)
 *     on it via `kernel.bus_chain_configs` — the reactor copies the event's
 *     `payload.context_type` straight into `attestations.context_type`, and
 *     every connector already tags its bus events with `context_type` equal
 *     to its own channel name (e.g. `'github'`, `'discord'`). So this source
 *     covers every connector automatically as more of its events grow an
 *     attestation reactor — no schema change needed here to pick them up.
 *
 *   - `github.action_proposals` (status = 'done'), the GitHub connector's
 *     signed confirm-rail ledger (#1366): every row already carries the
 *     connector scope that authorized it, the owner DID, the acting agent DID
 *     (null = the owner acted directly), and a signed `ownerAuthorization`.
 *     Only GitHub has adopted this ledger shape so far; other connectors that
 *     grow an equivalent per-action proposal/confirm ledger can be added here
 *     the same way (see the follow-up note below).
 *
 * Relational shape (owner/consumer, per the #1799 follow-up comment): a
 * rollup is always computed for an `ownerDid` (the connector's grant owner)
 * and an optional `consumerDid` (the DID that acted / drew on the owner's
 * connector resources). Omitting `consumerDid` aggregates across every
 * consumer, which is what "my own connector usage" means when owner and
 * caller are the same DID.
 *
 * DID-level access control is enforced by the route, not here: this module
 * has no notion of "who is asking", only "whose pair am I rolling up".
 *
 * Follow-up: only GitHub has a per-action signed ledger today. As Discord,
 * QuickBooks, and the credential-paste connectors (Gemini/Anthropic/GCP/Warp)
 * grow their own confirm-rail-shaped tables (or start firing attestation-
 * producing bus events), add a reader here the same way `readGithubActionCounts`
 * was added — the rollup shape and access-control boundary do not change.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, attestations, githubActionProposals } from '@/src/db';
import type { ConnectorEntry } from './connector-registry';

// ── Row shapes read from each source ───────────────────────────────────────

/** One grouped row from `auth.attestations`. */
export interface AttestationCountRow {
  type: string;
  count: number;
  firstSeenAt: string | Date;
  lastSeenAt: string | Date;
}

/** One grouped row from `github.action_proposals`. */
export interface GithubActionCountRow {
  tool: string;
  count: number;
  firstSeenAt: string | Date;
  lastSeenAt: string | Date;
}

// ── Rollup output ────────────────────────────────────────────────────────────

export interface ConnectorTelemetryKindCount {
  /** Which source this count came from. */
  source: 'attestation' | 'github_action';
  /** The attestation `type`, or the action-proposal `tool` name. */
  kind: string;
  count: number;
}

export interface ConnectorTelemetryRollup {
  connectorId: string;
  ownerDid: string;
  /** null = aggregated across every consumer. */
  consumerDid: string | null;
  /** The connector's registered scope(s) this rollup is scoped to. */
  scopes: string[];
  totalCount: number;
  byKind: ConnectorTelemetryKindCount[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

// ── Pure aggregation (no I/O — mirrors buildConnectorConnectionStatus) ──────

/**
 * Combine pre-fetched rows from every source into one rollup. Kept pure and
 * separate from the DB reads so the aggregation logic is testable without
 * mocking `db` (mirrors the `buildConnectorConnectionStatus` /
 * `readConnectorConnectionStatus` split in `./connector-status.ts`).
 */
export function buildConnectorTelemetryRollup(
  entry: ConnectorEntry,
  ownerDid: string,
  consumerDid: string | null,
  attestationRows: readonly AttestationCountRow[],
  githubActionRows: readonly GithubActionCountRow[] = [],
): ConnectorTelemetryRollup {
  const byKind: ConnectorTelemetryKindCount[] = [
    ...attestationRows.map((row) => ({ source: 'attestation' as const, kind: row.type, count: row.count })),
    ...githubActionRows.map((row) => ({ source: 'github_action' as const, kind: row.tool, count: row.count })),
  ];

  const totalCount = byKind.reduce((sum, row) => sum + row.count, 0);

  const timestampsMs = [...attestationRows, ...githubActionRows]
    .flatMap((row) => [row.firstSeenAt, row.lastSeenAt])
    .map((ts) => new Date(ts).getTime())
    .filter((ms) => !Number.isNaN(ms));

  return {
    connectorId: entry.id,
    ownerDid,
    consumerDid,
    scopes: entry.scopes.map((scope) => scope.name),
    totalCount,
    byKind,
    firstSeenAt: timestampsMs.length > 0 ? new Date(Math.min(...timestampsMs)).toISOString() : null,
    lastSeenAt: timestampsMs.length > 0 ? new Date(Math.max(...timestampsMs)).toISOString() : null,
  };
}

// ── DB reads ─────────────────────────────────────────────────────────────────

/**
 * Rows from `auth.attestations` for this connector's channel, grouped by type.
 *
 * The DID-pair condition is order-independent: with a `consumerDid`, a row
 * counts only when {issuerDid, subjectDid} equals {ownerDid, consumerDid} as a
 * set. Without one, any attestation naming `ownerDid` on either side counts —
 * "everything signed under this connector for me", aggregated over consumers.
 */
async function readAttestationCounts(
  channel: string,
  ownerDid: string,
  consumerDid: string | null,
): Promise<AttestationCountRow[]> {
  const didPairCondition = consumerDid
    ? or(
        and(eq(attestations.issuerDid, ownerDid), eq(attestations.subjectDid, consumerDid)),
        and(eq(attestations.issuerDid, consumerDid), eq(attestations.subjectDid, ownerDid)),
      )
    : or(eq(attestations.issuerDid, ownerDid), eq(attestations.subjectDid, ownerDid));

  return db
    .select({
      type: attestations.type,
      count: sql<number>`COUNT(*)::int`,
      firstSeenAt: sql<string>`MIN(${attestations.issuedAt})`,
      lastSeenAt: sql<string>`MAX(${attestations.issuedAt})`,
    })
    .from(attestations)
    .where(and(eq(attestations.contextType, channel), isNull(attestations.revokedAt), didPairCondition))
    .groupBy(attestations.type);
}

/**
 * Rows from `github.action_proposals` for a completed ('done') write, scoped
 * to the connector's registered scopes, grouped by tool.
 *
 * `agentDid` is null when the owner acted directly (no delegate). A
 * `consumerDid` equal to `ownerDid` therefore means "the owner's own direct
 * actions"; any other `consumerDid` names a specific delegate.
 */
async function readGithubActionCounts(
  scopeNames: readonly string[],
  ownerDid: string,
  consumerDid: string | null,
): Promise<GithubActionCountRow[]> {
  const conditions = [
    eq(githubActionProposals.ownerDid, ownerDid),
    eq(githubActionProposals.status, 'done'),
  ];
  if (scopeNames.length > 0) {
    conditions.push(inArray(githubActionProposals.scope, scopeNames));
  }
  if (consumerDid) {
    conditions.push(
      consumerDid === ownerDid
        ? isNull(githubActionProposals.agentDid)
        : eq(githubActionProposals.agentDid, consumerDid),
    );
  }

  return db
    .select({
      tool: githubActionProposals.tool,
      count: sql<number>`COUNT(*)::int`,
      firstSeenAt: sql<string>`MIN(${githubActionProposals.createdAt})`,
      lastSeenAt: sql<string>`MAX(${githubActionProposals.createdAt})`,
    })
    .from(githubActionProposals)
    .where(and(...conditions))
    .groupBy(githubActionProposals.tool);
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Read the connector telemetry rollup for `ownerDid` (optionally narrowed to
 * one `consumerDid`), scoped to `entry`'s registered scope(s).
 *
 * Caller (the route) is responsible for DID-level access control — this
 * function trusts the DIDs it is given.
 */
export async function readConnectorTelemetry(
  entry: ConnectorEntry,
  ownerDid: string,
  consumerDid: string | null,
): Promise<ConnectorTelemetryRollup> {
  const scopeNames = entry.scopes.map((scope) => scope.name);

  const [attestationRows, githubActionRows] = await Promise.all([
    readAttestationCounts(entry.channel, ownerDid, consumerDid),
    entry.channel === 'github'
      ? readGithubActionCounts(scopeNames, ownerDid, consumerDid)
      : Promise.resolve<GithubActionCountRow[]>([]),
  ]);

  return buildConnectorTelemetryRollup(entry, ownerDid, consumerDid, attestationRows, githubActionRows);
}
