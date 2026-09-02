/**
 * Daily provider-billed-usage ingestion sweep (#1076 Stage 1).
 *
 * For every principal with an active `{provider}:billing` grant, pulls
 * yesterday (day granularity, settled) and the current month-to-date (month
 * granularity, still moving) from that provider's own usage/cost admin API
 * and upserts both into `usage.billed`. Wired to `GET /api/cron/usage-billed-ingest`,
 * scheduled daily in `vercel.json` — same shape as the QuickBooks reconcile
 * sweep (`app/api/cron/quickbooks-reconcile/route.ts`).
 *
 * Fails open at both levels: an auth failure (401/403 — key missing or
 * insufficiently scoped) for one owner+provider is logged and skipped, and
 * any other per-pull failure is collected without aborting the rest of the
 * sweep, so one broken credential never blocks every other principal or
 * provider from ingesting.
 */
import { createLogger } from '@imajin/logger';
import { listBillingGrantOwners as listAnthropicOwners, loadAnthropicBillingCredentials } from '@/src/lib/anthropic/billing-connector';
import { listBillingGrantOwners as listOpenaiOwners, loadOpenaiBillingCredentials } from '@/src/lib/openai/billing-connector';
import { createAnthropicBilledUsageReader } from './anthropic';
import { createOpenAIBilledUsageReader } from './openai';
import { ingestBilledUsage } from './ingest';
import { BillingApiError, type BilledUsageReader, type BilledPeriod, type BilledGranularity } from './types';

const log = createLogger('kernel:usage:billed:ingest-job');

interface ProviderConfig {
  provider: string;
  listOwners: () => Promise<string[]>;
  loadAdminApiKey: (ownerDid: string) => Promise<string | undefined>;
  buildReader: (adminApiKey: string) => BilledUsageReader;
}

const PROVIDERS: readonly ProviderConfig[] = [
  {
    provider: 'anthropic',
    listOwners: listAnthropicOwners,
    loadAdminApiKey: async (ownerDid) => (await loadAnthropicBillingCredentials(ownerDid))?.apiKey,
    buildReader: (adminApiKey) => createAnthropicBilledUsageReader({ adminApiKey }),
  },
  {
    provider: 'openai',
    listOwners: listOpenaiOwners,
    loadAdminApiKey: async (ownerDid) => (await loadOpenaiBillingCredentials(ownerDid))?.apiKey,
    buildReader: (adminApiKey) => createOpenAIBilledUsageReader({ adminApiKey }),
  },
];

interface PullWindow {
  granularity: BilledGranularity;
  period: BilledPeriod;
}

/** [start of yesterday, start of today) UTC — a settled, complete day. */
function yesterdayWindow(now: Date): PullWindow {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setUTCDate(startOfYesterday.getUTCDate() - 1);
  return { granularity: 'day', period: { start: startOfYesterday, end: startOfToday } };
}

/** [start of this month, now) UTC — still moving, re-pulled and upserted in place every run. */
function monthToDateWindow(now: Date): PullWindow {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { granularity: 'month', period: { start: startOfMonth, end: now } };
}

export interface BilledIngestResult {
  provider: string;
  ownerDid: string;
  granularity: BilledGranularity;
  rowsWritten: number;
}

export interface BilledIngestFailure {
  provider: string;
  ownerDid: string;
  granularity: BilledGranularity;
  error: string;
  /** True when the failure was an auth error (401/403) — fail-open, logged and skipped. */
  authError: boolean;
}

export interface BilledIngestSweepResult {
  owners: number;
  results: BilledIngestResult[];
  failures: BilledIngestFailure[];
}

async function pullWindow(
  provider: string,
  ownerDid: string,
  reader: BilledUsageReader,
  window: PullWindow,
): Promise<BilledIngestResult | BilledIngestFailure> {
  try {
    const lines = await reader.fetch(window.period, window.granularity);
    const rowsWritten = await ingestBilledUsage({
      principalDid: ownerDid,
      provider,
      period: window.period,
      granularity: window.granularity,
      lines,
    });
    return { provider, ownerDid, granularity: window.granularity, rowsWritten };
  } catch (err) {
    const authError = err instanceof BillingApiError && err.isAuthError;
    if (authError) {
      log.warn({ provider, ownerDid, granularity: window.granularity }, 'billed usage pull skipped — admin key missing or insufficiently scoped');
    } else {
      log.error({ err: String(err), provider, ownerDid, granularity: window.granularity }, 'billed usage pull failed');
    }
    return { provider, ownerDid, granularity: window.granularity, error: String(err), authError };
  }
}

function isFailure(row: BilledIngestResult | BilledIngestFailure): row is BilledIngestFailure {
  return 'error' in row;
}

/** Pull + upsert both windows for one owner+provider, once credentials are resolved. */
async function ingestOwnerProvider(
  config: ProviderConfig,
  ownerDid: string,
  now: Date,
): Promise<Array<BilledIngestResult | BilledIngestFailure>> {
  let adminApiKey: string | undefined;
  try {
    adminApiKey = await config.loadAdminApiKey(ownerDid);
  } catch (err) {
    log.error({ err: String(err), provider: config.provider, ownerDid }, 'billed usage credential resolution failed');
    return [{ provider: config.provider, ownerDid, granularity: 'day', error: String(err), authError: false }];
  }

  if (!adminApiKey) {
    // Grant exists but no key sealed (or vault custody pending) — fail-open,
    // same "no usable connection" treatment `loadCredentials` documents.
    log.warn({ provider: config.provider, ownerDid }, 'billed usage: active grant but no admin key sealed — skipping');
    return [];
  }

  const reader = config.buildReader(adminApiKey);
  const windows = [yesterdayWindow(now), monthToDateWindow(now)];
  const rows: Array<BilledIngestResult | BilledIngestFailure> = [];
  for (const window of windows) {
    rows.push(await pullWindow(config.provider, ownerDid, reader, window));
  }
  return rows;
}

/**
 * Run the full sweep across every configured provider. `now` is injectable
 * for tests; defaults to the current time.
 */
export async function runBilledUsageIngestion(now: Date = new Date()): Promise<BilledIngestSweepResult> {
  const results: BilledIngestResult[] = [];
  const failures: BilledIngestFailure[] = [];
  const ownersSeen = new Set<string>();

  for (const config of PROVIDERS) {
    let owners: string[];
    try {
      owners = await config.listOwners();
    } catch (err) {
      log.error({ err: String(err), provider: config.provider }, 'billed usage: failed to enumerate owners — skipping provider');
      continue;
    }

    for (const ownerDid of owners) {
      ownersSeen.add(ownerDid);
      const rows = await ingestOwnerProvider(config, ownerDid, now);
      for (const row of rows) {
        if (isFailure(row)) failures.push(row);
        else results.push(row);
      }
    }
  }

  log.info(
    { owners: ownersSeen.size, results: results.length, failures: failures.length },
    'billed usage ingestion sweep complete',
  );

  return { owners: ownersSeen.size, results, failures };
}
