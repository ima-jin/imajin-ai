/**
 * Anthropic `BilledUsageReader` adapter (#1076 Stage 1).
 *
 * Pulls Anthropic's Usage & Cost Admin API — the counterparty's own
 * statement of what we were actually charged — and normalizes it into
 * `BilledLine[]`. Requires an Admin API key (`sk-ant-admin...`), sealed via
 * `@/src/lib/anthropic/billing-connector` under the `anthropic:billing`
 * scope; this is a DIFFERENT credential from the inference key.
 *
 * Endpoints verified against the current Anthropic docs before implementing
 * (cited in the #1076 Stage 1 PR body):
 *   - `GET /v1/organizations/usage_report/messages` — token usage, grouped
 *     by model. https://platform.claude.com/docs/en/api/admin/usage_report/retrieve_messages
 *   - `GET /v1/organizations/cost_report` — USD cost, grouped by
 *     `description` (which — per the reference response shape — carries a
 *     parsed `model` field alongside the dollar `amount`).
 *     https://platform.claude.com/docs/en/api/admin/cost_report/retrieve
 *
 * Both endpoints only support `bucket_width: '1d'` for the cost report (the
 * usage report also allows `1h`/`1m`, unused here), so a 'month' pull is
 * requested as a run of daily buckets and summed client-side into one line
 * per model for the whole window — `usage.billed` stores one row per
 * (principal, provider, period, granularity, model), not per day.
 *
 * ## `cost_report.amount` unit ambiguity
 * Anthropic's own reference page states costs are "reported as decimal
 * strings in lowest units (e.g. cents)" — e.g. `"123.45"` representing
 * $1.23 — which this adapter follows (divide by 100). This is the same
 * reading the official Usage & Cost Admin API cookbook's reference Python
 * implementation uses (`cost_usd = bucket_cost / 100`,
 * https://platform.claude.com/cookbook/observability-usage-cost-api).
 * Flagged here because a raw example response elsewhere in the docs shows an
 * `amount` value large enough to look like literal dollars rather than
 * cents — worth a spot-check against a real invoice before this ships past
 * Stage 1.
 */
import { createLogger } from '@imajin/logger';
import { BillingApiError, type BilledUsageReader, type BilledPeriod, type BilledGranularity, type BilledLine } from './types';

const log = createLogger('kernel:usage:billed:anthropic');

const API_BASE = 'https://api.anthropic.com/v1/organizations';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicUsageResult {
  model?: string | null;
  uncached_input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

interface AnthropicUsageBucket {
  starting_at: string;
  ending_at: string;
  results: AnthropicUsageResult[];
}

interface AnthropicUsageReportResponse {
  data: AnthropicUsageBucket[];
  has_more: boolean;
  next_page: string | null;
}

interface AnthropicCostResult {
  amount: string;
  description?: string | null;
  model?: string | null;
  cost_type?: string | null;
}

interface AnthropicCostBucket {
  starting_at: string;
  ending_at: string;
  results: AnthropicCostResult[];
}

interface AnthropicCostReportResponse {
  data: AnthropicCostBucket[];
  has_more: boolean;
  next_page: string | null;
}

async function anthropicGet<T>(
  adminApiKey: string,
  path: string,
  params: Record<string, string | string[]>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(`${key}[]`, v);
    } else {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetchImpl(url.toString(), {
    headers: {
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': adminApiKey,
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new BillingApiError('anthropic', response.status, `Anthropic billing API returned ${response.status} — admin key missing or insufficiently scoped`);
    }
    throw new BillingApiError('anthropic', response.status, `Anthropic billing API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/** Accumulate token usage per model across every bucket in the window, paginating. */
async function fetchUsageByModel(
  adminApiKey: string,
  period: BilledPeriod,
  fetchImpl: typeof fetch,
): Promise<Map<string | null, { tokensIn: number; tokensOut: number; raw: AnthropicUsageResult[] }>> {
  const byModel = new Map<string | null, { tokensIn: number; tokensOut: number; raw: AnthropicUsageResult[] }>();
  let page: string | undefined;

  do {
    const response: AnthropicUsageReportResponse = await anthropicGet(adminApiKey, '/usage_report/messages', {
      starting_at: period.start.toISOString(),
      ending_at: period.end.toISOString(),
      bucket_width: '1d',
      'group_by': ['model'],
      ...(page ? { page } : {}),
    }, fetchImpl);

    for (const bucket of response.data) {
      for (const result of bucket.results) {
        const model = result.model ?? null;
        const cacheCreation = (result.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (result.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        const tokensIn = (result.uncached_input_tokens ?? 0) + (result.cache_read_input_tokens ?? 0) + cacheCreation;
        const tokensOut = result.output_tokens ?? 0;
        const existing = byModel.get(model) ?? { tokensIn: 0, tokensOut: 0, raw: [] };
        existing.tokensIn += tokensIn;
        existing.tokensOut += tokensOut;
        existing.raw.push(result);
        byModel.set(model, existing);
      }
    }

    page = response.has_more ? (response.next_page ?? undefined) : undefined;
  } while (page);

  return byModel;
}

/** Accumulate USD cost per model across every bucket in the window, paginating. */
async function fetchCostByModel(
  adminApiKey: string,
  period: BilledPeriod,
  fetchImpl: typeof fetch,
): Promise<Map<string | null, { billedUsd: number; raw: AnthropicCostResult[] }>> {
  const byModel = new Map<string | null, { billedUsd: number; raw: AnthropicCostResult[] }>();
  let page: string | undefined;

  do {
    const response: AnthropicCostReportResponse = await anthropicGet(adminApiKey, '/cost_report', {
      starting_at: period.start.toISOString(),
      ending_at: period.end.toISOString(),
      bucket_width: '1d',
      'group_by': ['description'],
      ...(page ? { page } : {}),
    }, fetchImpl);

    for (const bucket of response.data) {
      for (const result of bucket.results) {
        const model = result.model ?? null;
        // See module doc comment for the cents-vs-dollars ambiguity this divide-by-100 resolves.
        const amountUsd = Number(result.amount) / 100;
        const existing = byModel.get(model) ?? { billedUsd: 0, raw: [] };
        existing.billedUsd += amountUsd;
        existing.raw.push(result);
        byModel.set(model, existing);
      }
    }

    page = response.has_more ? (response.next_page ?? undefined) : undefined;
  } while (page);

  return byModel;
}

export interface AnthropicBilledUsageReaderOptions {
  adminApiKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createAnthropicBilledUsageReader(opts: AnthropicBilledUsageReaderOptions): BilledUsageReader {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    provider: 'anthropic',
    async fetch(period: BilledPeriod, granularity: BilledGranularity): Promise<BilledLine[]> {
      const [usageByModel, costByModel] = await Promise.all([
        fetchUsageByModel(opts.adminApiKey, period, fetchImpl),
        fetchCostByModel(opts.adminApiKey, period, fetchImpl),
      ]);

      const models = new Set<string | null>([...usageByModel.keys(), ...costByModel.keys()]);
      const lines: BilledLine[] = [];
      for (const model of models) {
        const usage = usageByModel.get(model);
        const cost = costByModel.get(model);
        lines.push({
          model,
          tokensIn: usage?.tokensIn ?? null,
          tokensOut: usage?.tokensOut ?? null,
          billedUsd: cost?.billedUsd ?? null,
          raw: { usage: usage?.raw ?? [], cost: cost?.raw ?? [] },
        });
      }

      log.info({ provider: 'anthropic', granularity, models: lines.length }, 'Anthropic billed usage fetched');
      return lines;
    },
  };
}
