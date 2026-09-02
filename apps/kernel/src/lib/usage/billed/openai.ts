/**
 * OpenAI `BilledUsageReader` adapter (#1076 Stage 1).
 *
 * Pulls OpenAI's organization usage/cost surface — the counterparty's own
 * statement of what we were actually charged — and normalizes it into
 * `BilledLine[]`. Requires an org ADMIN API key, sealed via
 * `@/src/lib/openai/billing-connector` under the `openai:billing` scope;
 * this is a DIFFERENT credential from the inference key.
 *
 * Endpoints verified against the current OpenAI docs before implementing
 * (cited in the #1076 Stage 1 PR body):
 *   - `GET /v1/organization/usage/completions` — token usage, groupable by
 *     `model`. https://platform.openai.com/docs/api-reference/usage/completions
 *   - `GET /v1/organization/costs` — USD cost, groupable only by
 *     `project_id` / `line_item` / `api_key_id` — NOT by model.
 *     https://platform.openai.com/docs/api-reference/usage/costs
 *
 * Because the costs endpoint cannot be broken down by model, this adapter
 * emits per-model lines carrying tokens only (`billedUsd: null`) alongside
 * ONE aggregate line (`model: null`) carrying the whole window's total USD
 * cost. That split is real, not a shortcut: OpenAI's own docs note "the
 * Usage API ... may not always reconcile perfectly with the Costs" and
 * recommend the Costs endpoint for the actual dollar figure — this adapter
 * follows that guidance rather than trying to reverse-engineer a per-model
 * price from the two independently-sourced numbers.
 *
 * `costs.amount` is the SDK-typed `{ value: number; currency: string }`
 * shape (`value` already in USD dollars, not cents) — confirmed against the
 * generated `openai-python`/`openai-node` client types, which are more
 * authoritative than a couple of third-party doc mirrors that show a bare
 * numeric-string `amount` instead.
 */
import { createLogger } from '@imajin/logger';
import { BillingApiError, type BilledUsageReader, type BilledPeriod, type BilledGranularity, type BilledLine } from './types';

const log = createLogger('kernel:usage:billed:openai');

const API_BASE = 'https://api.openai.com/v1/organization';

interface OpenAIUsageCompletionsResult {
  object: 'organization.usage.completions.result';
  input_tokens: number;
  output_tokens: number;
  model?: string | null;
  num_model_requests?: number;
}

interface OpenAIUsageBucket {
  object: 'bucket';
  start_time: number;
  end_time: number;
  results: OpenAIUsageCompletionsResult[];
}

interface OpenAIUsageResponse {
  object: 'page';
  data: OpenAIUsageBucket[];
  has_more: boolean;
  next_page: string | null;
}

interface OpenAICostsResult {
  object: 'organization.costs.result';
  amount?: { value?: number; currency?: string } | null;
  line_item?: string | null;
  project_id?: string | null;
}

interface OpenAICostsBucket {
  object: 'bucket';
  start_time: number;
  end_time: number;
  results: OpenAICostsResult[];
}

interface OpenAICostsResponse {
  object: 'page';
  data: OpenAICostsBucket[];
  has_more: boolean;
  next_page: string | null;
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function openaiGet<T>(
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
    headers: { Authorization: `Bearer ${adminApiKey}` },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new BillingApiError('openai', response.status, `OpenAI billing API returned ${response.status} — admin key missing or insufficiently scoped`);
    }
    throw new BillingApiError('openai', response.status, `OpenAI billing API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/** Accumulate token usage per model across every bucket in the window, paginating. */
async function fetchUsageByModel(
  adminApiKey: string,
  period: BilledPeriod,
  fetchImpl: typeof fetch,
): Promise<Map<string | null, { tokensIn: number; tokensOut: number; raw: OpenAIUsageCompletionsResult[] }>> {
  const byModel = new Map<string | null, { tokensIn: number; tokensOut: number; raw: OpenAIUsageCompletionsResult[] }>();
  let page: string | undefined;

  do {
    const response: OpenAIUsageResponse = await openaiGet(adminApiKey, '/usage/completions', {
      start_time: String(toUnixSeconds(period.start)),
      end_time: String(toUnixSeconds(period.end)),
      bucket_width: '1d',
      'group_by': ['model'],
      limit: '31',
      ...(page ? { page } : {}),
    }, fetchImpl);

    for (const bucket of response.data) {
      for (const result of bucket.results) {
        const model = result.model ?? null;
        const existing = byModel.get(model) ?? { tokensIn: 0, tokensOut: 0, raw: [] };
        existing.tokensIn += result.input_tokens ?? 0;
        existing.tokensOut += result.output_tokens ?? 0;
        existing.raw.push(result);
        byModel.set(model, existing);
      }
    }

    page = response.has_more ? (response.next_page ?? undefined) : undefined;
  } while (page);

  return byModel;
}

/** Total USD cost across the whole window — OpenAI's costs endpoint has no per-model breakdown. */
async function fetchTotalCost(
  adminApiKey: string,
  period: BilledPeriod,
  fetchImpl: typeof fetch,
): Promise<{ billedUsd: number; raw: OpenAICostsResult[] }> {
  let billedUsd = 0;
  const raw: OpenAICostsResult[] = [];
  let page: string | undefined;

  do {
    const response: OpenAICostsResponse = await openaiGet(adminApiKey, '/costs', {
      start_time: String(toUnixSeconds(period.start)),
      end_time: String(toUnixSeconds(period.end)),
      bucket_width: '1d',
      limit: '31',
      ...(page ? { page } : {}),
    }, fetchImpl);

    for (const bucket of response.data) {
      for (const result of bucket.results) {
        billedUsd += result.amount?.value ?? 0;
        raw.push(result);
      }
    }

    page = response.has_more ? (response.next_page ?? undefined) : undefined;
  } while (page);

  return { billedUsd, raw };
}

export interface OpenAIBilledUsageReaderOptions {
  adminApiKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createOpenAIBilledUsageReader(opts: OpenAIBilledUsageReaderOptions): BilledUsageReader {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    provider: 'openai',
    async fetch(period: BilledPeriod, granularity: BilledGranularity): Promise<BilledLine[]> {
      const [usageByModel, totalCost] = await Promise.all([
        fetchUsageByModel(opts.adminApiKey, period, fetchImpl),
        fetchTotalCost(opts.adminApiKey, period, fetchImpl),
      ]);

      const lines: BilledLine[] = [];
      for (const [model, usage] of usageByModel) {
        lines.push({ model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, billedUsd: null, raw: usage.raw });
      }
      // Aggregate, org-wide cost line — see module doc comment for why this
      // cannot be attributed per model.
      lines.push({ model: null, tokensIn: null, tokensOut: null, billedUsd: totalCost.billedUsd, raw: totalCost.raw });

      log.info({ provider: 'openai', granularity, lines: lines.length }, 'OpenAI billed usage fetched');
      return lines;
    },
  };
}
