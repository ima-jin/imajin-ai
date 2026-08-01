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
import { db, vaultGrantRequests } from '@/src/db';
import { isVaultTier1 } from './sealing.js';
import { loadAndUnseal, sealAndStoreV2, vaultService } from './index.js';

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
}

export interface MigrationReport {
  dryRun: boolean;
  tier1: boolean;
  /** Total `node-sealed` fields found across the whole vault, before this run's `limit` was applied. */
  totalV1Fields: number;
  /** How many of those this run considered, after `limit`. */
  candidateCount: number;
  results: FieldMigrationResult[];
  aborted: boolean;
  abortReason?: string;
}

export interface MigrateCustodyOptions {
  /** Report what would change and mutate nothing. */
  dryRun: boolean;
  /** Cap how many v1 fields this call processes. Omit to process every remaining one. */
  limit?: number;
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
 * List every field currently under `node-sealed` (v1) custody, sorted for
 * stable, reproducible ordering across runs and repeated `limit`-bounded calls.
 *
 * `vaultService.list()` already collapses to the latest entry per field and
 * excludes tombstones, so a deleted or superseded v1 entry never appears here.
 */
export async function listNodeSealedFields(): Promise<string[]> {
  const entries = await vaultService.list();
  return entries
    .filter((entry) => (entry.custodyScheme ?? 'node-sealed') === 'node-sealed')
    .map((entry) => entry.field)
    .sort();
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

/**
 * Poll `field` until it unseals to `expectedPlaintext` or `timeoutMs` elapses.
 *
 * A thrown error while polling is the expected shape of "not ready yet" under
 * Tier 1 — a `VaultDelegationError` because the grant is still pending
 * fulfilment — so it is swallowed here and retried, not treated as failure in
 * itself. Only running out of time counts as failure.
 */
async function pollUntilReadable(
  field: string,
  expectedPlaintext: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const plaintext = await loadAndUnseal(field);
      if (plaintext === expectedPlaintext) {
        return true;
      }
    } catch {
      // Not yet readable — e.g. a Tier 1 grant is still pending fulfilment.
      // Keep polling until the deadline.
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

interface UpgradeVerifyOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
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
): Promise<{ status: 'upgraded' | 'upgrade-failed' | 'verify-failed'; grantId: string | null; error?: string }> {
  let grantId: string | null;
  try {
    ({ grantId } = await sealAndStoreV2(field, plaintext));
  } catch (err) {
    log.error({ err: String(err), field }, 'Vault migrate-custody: upgrade failed');
    return { status: 'upgrade-failed', grantId: null, error: String(err) };
  }

  const readable = await pollUntilReadable(field, plaintext, opts.timeoutMs, opts.pollIntervalMs, opts.sleep);
  if (!readable) {
    return {
      status: 'verify-failed',
      grantId,
      error: `field '${field}' did not unseal within ${opts.timeoutMs}ms after upgrade`,
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
 * `limit` bounds how many fields a single call considers. An operator doing a
 * large migration should pass a small limit and call again — each call is one
 * request/response with no background job — rather than expect one call to
 * walk the entire vault.
 */
export async function migrateCustody(options: MigrateCustodyOptions): Promise<MigrationReport> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stalePendingThresholdMs = options.stalePendingThresholdMs ?? DEFAULT_STALE_PENDING_THRESHOLD_MS;
  const sleep = options.sleep ?? defaultSleep;
  const tier1 = isVaultTier1();

  const allFields = await listNodeSealedFields();
  const candidates = typeof options.limit === 'number' ? allFields.slice(0, options.limit) : allFields;

  const base = {
    dryRun: options.dryRun,
    tier1,
    totalV1Fields: allFields.length,
    candidateCount: candidates.length,
  };

  if (options.dryRun) {
    return {
      ...base,
      results: candidates.map((field) => ({ field, status: 'would-upgrade' as const })),
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
  const [canaryField, ...rest] = candidates;

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

  const canaryResult = await upgradeAndVerify(canaryField, canaryPlaintext, { timeoutMs, pollIntervalMs, sleep });
  results.push({ field: canaryField, ...canaryResult });

  if (canaryResult.status !== 'upgraded') {
    log.error(
      { field: canaryField, canaryStatus: canaryResult.status },
      'Vault migrate-custody: canary failed — aborting batch',
    );
    return {
      ...base,
      results,
      aborted: true,
      abortReason: `canary field '${canaryField}' did not come back readable — refusing to migrate the remaining ${rest.length} field(s)`,
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

    const fieldResult = await upgradeAndVerify(field, plaintext, { timeoutMs, pollIntervalMs, sleep });
    results.push({ field, ...fieldResult });

    if (fieldResult.status !== 'upgraded') {
      return {
        ...base,
        results,
        aborted: true,
        abortReason: `field '${field}' failed to verify after upgrade — aborting with ${results.length} of ${candidates.length} field(s) processed`,
      };
    }
  }

  log.info({ processed: results.length, tier1 }, 'Vault migrate-custody: batch complete');
  return { ...base, results, aborted: false };
}
