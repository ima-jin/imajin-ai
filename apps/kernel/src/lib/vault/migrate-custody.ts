/**
 * Batch v1→v2 vault custody migration (#1537).
 *
 * `POST /api/vault/upgrade-custody` already migrates one field: it unseals a
 * `node-sealed` (v1) entry server-side and re-seals it as `delegation-grant`
 * (v2), idempotently and with no value re-entry. What was missing was a driver
 * that enumerates the v1 set and works through it, rather than an operator
 * curling one field at a time. This module is that driver.
 *
 * `POST /api/vault/rotation-sweep` is not a model for this: its export phase
 * enumerates fields with an *active delegation grant* — i.e. already v2 — so
 * it never sees the entries this migrator exists to reach.
 *
 * ## Why a canary, not a static health flag
 *
 * The obvious ask — "refuse to start when Tier 1 is unhealthy" — has no cheap
 * answer: an idle owner agent and a dead one look identical from the database.
 * Rather than invent a static readiness flag that cannot actually distinguish
 * the two, this migrates exactly ONE field first (the canary), then polls
 * until it unseals or a timeout expires. Only on success does it continue with
 * the rest. That is a liveness proof, not a guess, and it bounds worst-case
 * exposure: a batch run with no owner agent running takes at most one field
 * offline, not the whole set.
 *
 * A cheap static guard runs first and costs one query: if a
 * `vault_grant_requests` row has been `pending` longer than a threshold, an
 * owner agent is already wedged and there is no reason to spend a canary
 * finding that out again.
 *
 * ## Sequencing this assumes
 *
 * Owner envelopes are written automatically on every v2 seal (#1521/#1534), so
 * a migrated entry gets one for free — no extra step here. Under Tier 1 the
 * owner agent (`imajin-cli vault serve`) must already be running: this
 * migrator does not start one, only detects whether one is responding. And
 * because losing the owner key after Tier-1 sealing loses the secrets
 * outright, the owner key must be backed up (`imajin vault backup`) before
 * migrating production.
 *
 * No plaintext is logged anywhere in this module — only field names, grant
 * ids, and error strings.
 */
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { VaultIntegrityError, type VaultEntry } from '@imajin/vault-core';
import { db, vaultGrantRequests } from '@/src/db';
import { isVaultTier1 } from './sealing';
import { VaultDelegationError } from './errors';
import { loadAndUnseal, sealAndStoreV2, vaultService } from './index';

const log = createLogger('kernel');

/** Default cap on how long a canary / per-field verification poll waits for a field to unseal. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default spacing between unseal attempts while polling. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/**
 * A `vault_grant_requests` row pending longer than this is treated as evidence
 * the owner agent is already wedged, not merely offline for a moment.
 */
const DEFAULT_STALE_PENDING_THRESHOLD_MS = 15 * 60 * 1000;

export type FieldMigrationStatus = 'would-upgrade' | 'upgraded' | 'upgrade-failed' | 'verify-failed';

export interface FieldMigrationResult {
  field: string;
  status: FieldMigrationStatus;
  /**
   * Present once sealAndStoreV2 has run for the field. Under Tier 1 this is
   * `null` — the grant is pending, not self-granted — even when the field
   * ultimately fails to verify.
   */
  grantId?: string | null;
  error?: string;
  /**
   * The current entry's owner DID, truncated to 20 chars (#2311) — a
   * dry-run-only diagnostic so an operator can confirm which owners a
   * `--fields` run will touch before mutating anything. Never plaintext or
   * key material, and never set on a real (non-dry-run) result: those
   * already carry `grantId`/`error` instead.
   */
  ownerDidTruncated?: string;
}

export interface MigrationReport {
  dryRun: boolean;
  tier1: boolean;
  /** Total live `node-sealed` fields found across the whole vault, before this run's `limit`/`fields` scoping was applied. */
  totalV1Fields: number;
  /** How many of those this run considered, after `fields`/`limit` scoping. */
  candidateCount: number;
  results: FieldMigrationResult[];
  aborted: boolean;
  abortReason?: string;
  /**
   * Fields named in `fields` that are not currently in the live v1 set —
   * already migrated, deleted, or a typo (#2311). Present only when `fields`
   * was passed.
   */
  notFound?: string[];
}

export interface MigrateCustodyOptions {
  /** Report what would change and mutate nothing. */
  dryRun: boolean;
  /** Cap how many v1 fields this call processes. Omit to process every remaining one. */
  limit?: number;
  /**
   * Restrict this run to exactly these field names (#2311) — the operator's
   * targeted-mode escape hatch for migrating a known, specific set (e.g. the
   * 15 fields the Aug-1 batch missed) instead of the whole remaining vault.
   * A name with no live v1 entry is reported back in `notFound` rather than
   * silently ignored. Omit to consider every live v1 field.
   */
  fields?: string[];
  /** How long to wait for a field to become readable after upgrade before giving up. */
  timeoutMs?: number;
  /** Spacing between unseal attempts while waiting. */
  pollIntervalMs?: number;
  /** Threshold past which a pending grant request is treated as a wedged owner agent. */
  stalePendingThresholdMs?: number;
  now?: Date;
  /** Test hook: replace the real timer-based wait. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the true latest entry per field from a raw, possibly out-of-order,
 * `vault.entries` array.
 *
 * `vault.entries` is append-only, but "latest" here was previously read as
 * "last element in the array" (see `vaultService.list()`/`getLatestEntry()`)
 * — correct only when every writer appends in strictly increasing `timestamp`
 * order. `InMemoryFieldLock` only serialises writers within a single Node
 * process, so two kernel processes/instances appending to the same
 * `vault.json` concurrently can interleave entries out of timestamp order.
 * When that happens to a field whose true-latest write is a live v1
 * (`node-sealed`) entry, a positional read can instead surface an older,
 * already-v2-looking entry as "latest" and hide the live one from every v1
 * enumeration that follows — this is how the Aug-1 batch migration (#1537)
 * missed 15 live v1 fields with zero delegation grants (#2311).
 *
 * Selecting by `timestamp`, with array order only as a tiebreak for equal (or
 * unparsable) timestamps, is immune to that reordering regardless of cause.
 */
function selectLatestEntries(entries: VaultEntry[]): Map<string, VaultEntry> {
  const ranked = entries.map((entry, index) => ({ entry, index }));
  ranked.sort((a, b) => {
    const aTime = Date.parse(a.entry.timestamp);
    const bTime = Date.parse(b.entry.timestamp);
    const aInvalid = Number.isNaN(aTime);
    const bInvalid = Number.isNaN(bTime);
    if (aInvalid !== bInvalid) {
      // An unparsable timestamp never outranks a valid one.
      return aInvalid ? -1 : 1;
    }
    if (!aInvalid && aTime !== bTime) {
      return aTime - bTime;
    }
    // Equal (or equally unparsable) timestamps: fall back to append order.
    return a.index - b.index;
  });

  const latestByField = new Map<string, VaultEntry>();
  for (const { entry } of ranked) {
    // Ascending sort — later entries in this loop overwrite earlier ones, so
    // the map ends up holding the true latest per field.
    latestByField.set(entry.field, entry);
  }
  return latestByField;
}

export interface LiveV1Field {
  field: string;
  /** ISO timestamp of the selected (latest) entry. */
  timestamp: string;
  /** DID that sealed the selected entry — the field's current owner. */
  ownerDid: string;
}

/**
 * Enumerate every field whose true latest entry (by `timestamp`, not array
 * position — see {@link selectLatestEntries}) is live (`deleted !== true`)
 * and still under `node-sealed` (v1) custody — `custodyScheme` absent or
 * explicitly `'node-sealed'` (#2311). Sorted by field name for stable,
 * reproducible ordering across runs and repeated `limit`-bounded calls.
 *
 * Reads the raw vault file directly rather than going through
 * `vaultService.list()`, which also asserts full entry integrity for every
 * field's latest entry — one unrelated corrupt entry anywhere in the vault
 * would then throw and hide every OTHER field's candidacy behind that
 * exception. Selection here is deliberately just metadata bookkeeping (field,
 * timestamp, custodyScheme, deleted, senderDid — never plaintext or key
 * material); integrity is still verified per-field the normal way the moment
 * a candidate is actually read for migration.
 */
export async function selectLiveV1Fields(): Promise<LiveV1Field[]> {
  const vault = await vaultService.loadVault();
  const latestByField = selectLatestEntries(vault.entries);

  const live: LiveV1Field[] = [];
  for (const entry of latestByField.values()) {
    if (entry.deleted === true) {
      continue;
    }
    if ((entry.custodyScheme ?? 'node-sealed') !== 'node-sealed') {
      continue;
    }
    live.push({ field: entry.field, timestamp: entry.timestamp, ownerDid: entry.senderDid });
  }
  return live.sort((a, b) => a.field.localeCompare(b.field));
}

/** Truncate a DID for dry-run/diagnostic display (#2311) — operator-facing only, never used for auth, storage, or comparison. */
function truncateDid(did: string): string {
  return did.length > 20 ? did.slice(0, 20) : did;
}

interface ScopedCandidates {
  candidates: LiveV1Field[];
  /** Requested field names with no live v1 entry right now. Undefined when `fields` was not passed. */
  notFound?: string[];
}

/**
 * Narrow the live v1 set to what this call should actually consider (#2311):
 * first to exactly the named `fields` (if given), tracking any that are not
 * currently live v1, then down to `limit` (if given). Split out of
 * {@link migrateCustody} to keep that function's branching budget for the
 * canary/batch state machine, which is where it matters most.
 */
function scopeCandidates(
  allFields: LiveV1Field[],
  fields: string[] | undefined,
  limit: number | undefined,
): ScopedCandidates {
  let scoped = allFields;
  let notFound: string[] | undefined;
  if (fields) {
    const requested = new Set(fields);
    scoped = allFields.filter((candidate) => requested.has(candidate.field));
    const found = new Set(scoped.map((candidate) => candidate.field));
    notFound = fields.filter((field) => !found.has(field));
  }
  const candidates = typeof limit === 'number' ? scoped.slice(0, limit) : scoped;
  return { candidates, notFound };
}

/**
 * Refuse-to-start guard: report the oldest `vault_grant_requests` row that has
 * been `pending` longer than `thresholdMs`, if any.
 *
 * A request lingers this long only when the owner agent that would fulfil it
 * is not running or is stuck — exactly the condition the issue calls
 * "Tier 1 configured but unhealthy". This costs one query and catches an
 * already-wedged agent before the canary is even written.
 */
async function findStalePendingRequest(
  now: Date,
  thresholdMs: number,
): Promise<{ field: string; requestId: string; ageMs: number } | undefined> {
  const rows = await db
    .select({
      field: vaultGrantRequests.field,
      requestId: vaultGrantRequests.requestId,
      createdAt: vaultGrantRequests.createdAt,
    })
    .from(vaultGrantRequests)
    .where(eq(vaultGrantRequests.status, 'pending'));

  const cutoff = now.getTime() - thresholdMs;
  let stalest: { field: string; requestId: string; ageMs: number } | undefined;
  for (const row of rows) {
    const createdAtMs = row.createdAt.getTime();
    if (createdAtMs > cutoff) {
      continue;
    }
    const ageMs = now.getTime() - createdAtMs;
    if (!stalest || ageMs > stalest.ageMs) {
      stalest = { field: row.field, requestId: row.requestId, ageMs };
    }
  }
  return stalest;
}

/** Outcome of a verification poll, carrying the diagnostic that explains a failure. */
interface PollOutcome {
  readable: boolean;
  /**
   * The last error thrown by `loadAndUnseal` before the deadline expired.
   * Undefined when the field never threw — it simply never unsealed to the
   * expected plaintext (or does not exist).
   */
  lastError?: unknown;
}

/**
 * Poll `field` until it unseals to `expectedPlaintext` or `timeoutMs` elapses.
 *
 * A thrown error while polling is the expected shape of "not ready yet" under
 * Tier 1 — a `VaultDelegationError` because the grant is still pending
 * fulfilment — so it does not stop the loop and is not treated as failure in
 * itself. Only running out of time counts as failure.
 *
 * It is, however, *retained* rather than discarded (#1556). "Grant still
 * pending" and "the upgrade produced a genuinely broken entry" both present as
 * a timeout, and without the underlying error an operator cannot tell the
 * transient case from the actionable one without reproducing the failure by
 * hand. Retaining only the LAST error is deliberate: the loop is a retry of
 * the same operation, so earlier attempts add noise, not information.
 */
async function pollUntilReadable(
  field: string,
  expectedPlaintext: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const plaintext = await loadAndUnseal(field);
      if (plaintext === expectedPlaintext) {
        return { readable: true };
      }
      // Unsealed, but not to what was just sealed. No error was raised, so
      // clear any stale one rather than blame a superseded attempt.
      lastError = undefined;
    } catch (err) {
      // Not yet readable — e.g. a Tier 1 grant is still pending fulfilment.
      // Keep polling until the deadline, but remember why.
      lastError = err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { readable: false, lastError };
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

/**
 * Turn the last polling error into an operator-facing clause.
 *
 * The two failure modes must stay visually distinct at a glance, because they
 * call for opposite responses:
 *   - `VaultDelegationError` — "still pending": the grant exists and is
 *     waiting on a Tier 1 owner agent. Wait, or start the agent.
 *   - `VaultIntegrityError` — "verification failed": the entry itself is
 *     broken (signature/cid/key-id mismatch). Waiting will never fix it; this
 *     needs investigating now. This is the case #1522 lost time to.
 * Anything else is surfaced raw rather than guessed at.
 */
function describePollFailure(lastError: unknown): string {
  if (lastError === undefined) {
    return 'no error was raised — the field never unsealed to the value just written';
  }
  if (lastError instanceof VaultDelegationError) {
    return `still pending: ${lastError.message}`;
  }
  if (lastError instanceof VaultIntegrityError) {
    return `verification failed (${lastError.code}): ${lastError.message}`;
  }
  return `verification failed: ${describeUnknownError(lastError)}`;
}

/** String-describe a caught value, avoiding default Object stringification for non-Error objects. */
function describeUnknownError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === null || value === undefined ? 'unknown error' : JSON.stringify(value);
}

interface UpgradeVerifyOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
}

interface UpgradeVerifyOutcome {
  status: 'upgraded' | 'upgrade-failed' | 'verify-failed';
  grantId: string | null;
  error?: string;
  /**
   * Short diagnostic clause for a non-`upgraded` outcome, so the caller can
   * fold the *reason* into its abort message instead of repeating the whole
   * per-field error string. Never set when the field upgraded cleanly.
   */
  failureDetail?: string;
}

/**
 * Upgrade one field to v2 and verify it still unseals before reporting success.
 *
 * This is the unit both the canary and every subsequent field in the batch run
 * through — "verify each upgraded field still unseals" is a per-field
 * guarantee, not a once-per-batch check.
 */
async function upgradeAndVerify(
  field: string,
  plaintext: string,
  opts: UpgradeVerifyOptions,
): Promise<UpgradeVerifyOutcome> {
  let grantId: string | null;
  try {
    ({ grantId } = await sealAndStoreV2(field, plaintext));
  } catch (err) {
    log.error({ err: String(err), field }, 'Vault migrate-custody: upgrade failed');
    return {
      status: 'upgrade-failed',
      grantId: null,
      error: String(err),
      failureDetail: `upgrade failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { readable, lastError } = await pollUntilReadable(
    field,
    plaintext,
    opts.timeoutMs,
    opts.pollIntervalMs,
    opts.sleep,
  );
  if (!readable) {
    const detail = describePollFailure(lastError);
    log.error({ field, detail }, 'Vault migrate-custody: field did not verify after upgrade');
    return {
      status: 'verify-failed',
      grantId,
      error: `field '${field}' did not unseal within ${opts.timeoutMs}ms after upgrade — ${detail}`,
      failureDetail: detail,
    };
  }
  return { status: 'upgraded', grantId };
}

/**
 * Enumerate `node-sealed` fields and upgrade them to `delegation-grant`
 * custody in small, verified steps.
 *
 * Dry run reports the candidate set and mutates nothing. A real run:
 *   1. Refuses to start if a grant request has been pending past the stale
 *      threshold (a wedged owner agent) — before anything is touched.
 *   2. Upgrades exactly one field (the canary) and waits for it to become
 *      readable. Aborts here, with nothing further touched, if it does not.
 *   3. Upgrades the rest of the candidates one at a time, verifying each in
 *      turn, aborting on the first failure and reporting per-field results so
 *      an operator knows exactly where it stopped.
 *
 * `fields` (#2311) scopes the candidate set to exactly the named fields
 * before `limit` is applied — the operator's targeted-mode escape hatch for
 * a known set (e.g. the 15 the Aug-1 batch missed) instead of the whole
 * remaining vault. `limit` bounds how many fields a single call considers.
 * An operator doing a large, untargeted migration should pass a small limit
 * and call again — each call is one request/response with no background job
 * — rather than expect one call to walk the entire vault.
 */
export async function migrateCustody(options: MigrateCustodyOptions): Promise<MigrationReport> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stalePendingThresholdMs = options.stalePendingThresholdMs ?? DEFAULT_STALE_PENDING_THRESHOLD_MS;
  const sleep = options.sleep ?? defaultSleep;
  const tier1 = isVaultTier1();

  const allFields = await selectLiveV1Fields();
  const { candidates, notFound } = scopeCandidates(allFields, options.fields, options.limit);

  const base = {
    dryRun: options.dryRun,
    tier1,
    totalV1Fields: allFields.length,
    candidateCount: candidates.length,
    ...(notFound !== undefined ? { notFound } : {}),
  };

  if (options.dryRun) {
    return {
      ...base,
      results: candidates.map((candidate) => ({
        field: candidate.field,
        status: 'would-upgrade' as const,
        ownerDidTruncated: truncateDid(candidate.ownerDid),
      })),
      aborted: false,
    };
  }

  const results: FieldMigrationResult[] = [];

  if (candidates.length === 0) {
    return { ...base, results, aborted: false };
  }

  // Cheap static guard, before the canary is even written.
  const stale = await findStalePendingRequest(now, stalePendingThresholdMs);
  if (stale) {
    return {
      ...base,
      results,
      aborted: true,
      abortReason:
        `refusing to start: grant request for field '${stale.field}' (requestId ${stale.requestId}) has been ` +
        `pending for ${Math.round(stale.ageMs / 1000)}s, past the ${Math.round(stalePendingThresholdMs / 1000)}s ` +
        'threshold — the owner agent appears unhealthy',
    };
  }

  // Canary: upgrade the first candidate and prove it becomes readable before
  // touching the rest of the batch.
  const [canaryCandidate, ...restCandidates] = candidates;
  const canaryField = canaryCandidate.field;
  const rest = restCandidates.map((candidate) => candidate.field);

  let canaryPlaintext: string | undefined;
  try {
    canaryPlaintext = await loadAndUnseal(canaryField);
  } catch (err) {
    results.push({ field: canaryField, status: 'upgrade-failed', error: String(err) });
    return {
      ...base,
      results,
      aborted: true,
      abortReason: `failed to read canary field '${canaryField}' before upgrade — aborting`,
    };
  }
  if (canaryPlaintext === undefined) {
    results.push({ field: canaryField, status: 'upgrade-failed', error: `field '${canaryField}' not found` });
    return { ...base, results, aborted: true, abortReason: `canary field '${canaryField}' vanished before migration` };
  }

  // `failureDetail` is diagnostic context for the abort message, not part of
  // the per-field report — destructure it out before pushing the result.
  const { failureDetail: canaryDetail, ...canaryResult } = await upgradeAndVerify(canaryField, canaryPlaintext, {
    timeoutMs,
    pollIntervalMs,
    sleep,
  });
  results.push({ field: canaryField, ...canaryResult });

  if (canaryResult.status !== 'upgraded') {
    log.error(
      { field: canaryField, canaryStatus: canaryResult.status, detail: canaryDetail },
      'Vault migrate-custody: canary failed — aborting batch',
    );
    return {
      ...base,
      results,
      aborted: true,
      abortReason:
        `canary field '${canaryField}' did not come back readable (${canaryDetail ?? 'no diagnostic available'}) — ` +
        `refusing to migrate the remaining ${rest.length} field(s)`,
    };
  }

  // Canary proved the owner agent (if any) is responding — proceed through
  // the rest, one at a time, aborting on the first verification failure.
  for (const field of rest) {
    let plaintext: string | undefined;
    try {
      plaintext = await loadAndUnseal(field);
    } catch (err) {
      results.push({ field, status: 'upgrade-failed', error: String(err) });
      return {
        ...base,
        results,
        aborted: true,
        abortReason: `failed to read field '${field}' before upgrade — aborting`,
      };
    }
    if (plaintext === undefined) {
      results.push({ field, status: 'upgrade-failed', error: `field '${field}' not found` });
      return { ...base, results, aborted: true, abortReason: `field '${field}' vanished mid-migration — aborting` };
    }

    const { failureDetail, ...fieldResult } = await upgradeAndVerify(field, plaintext, {
      timeoutMs,
      pollIntervalMs,
      sleep,
    });
    results.push({ field, ...fieldResult });

    if (fieldResult.status !== 'upgraded') {
      return {
        ...base,
        results,
        aborted: true,
        abortReason:
          `field '${field}' failed to verify after upgrade (${failureDetail ?? 'no diagnostic available'}) — ` +
          `aborting with ${results.length} of ${candidates.length} field(s) processed`,
      };
    }
  }

  log.info({ processed: results.length, tier1 }, 'Vault migrate-custody: batch complete');
  return { ...base, results, aborted: false };
}
