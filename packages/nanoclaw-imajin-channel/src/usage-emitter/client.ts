/**
 * Kernel ingest client (imajin-ai#1932, #1151) — posts batches to
 * `POST /usage/api/incurred`. Same CONTRACT as
 * `packages/usage-emitter-claude-code/src/client.ts` but implemented
 * independently (that package exports only its top-level CLI, not this
 * helper).
 *
 * Auth is a bearer app-service token read from the environment
 * (`USAGE_EMIT_TOKEN`) — `usage:emit` is `serviceEligible: true`
 * (`@imajin/auth`'s `SCOPE_VOCABULARY`), so a session-less app-service token
 * can carry it, matching the reference emitter's own design note on why this
 * is meant to be invoked periodically (cron/systemd timer) rather than run
 * as a long-lived daemon needing its own refresh loop.
 */
import { stripTrailingSlashes } from '../url-utils.js';
import type { MappedUsageRow } from './mapper.js';

export const MAX_BATCH_SIZE = 500;

export interface ClientConfig {
  kernelUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface IngestResponse {
  inserted: number;
  skipped: number;
  rejected: Array<{ index: number; reason: string }>;
}

/** Partition `rows` into batches no larger than `size`. */
export function chunkRows<T>(rows: readonly T[], size: number = MAX_BATCH_SIZE): T[][] {
  const batchCount = Math.ceil(rows.length / size);
  return Array.from({ length: batchCount }, (_, batchIndex) => rows.slice(batchIndex * size, (batchIndex + 1) * size));
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = { error: response.statusText };
  const body = (await response.json().catch(() => fallback)) as { error?: string };
  return body.error ?? response.statusText;
}

export async function postIncurredBatch(config: ClientConfig, rows: readonly MappedUsageRow[]): Promise<IngestResponse> {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = `${stripTrailingSlashes(config.kernelUrl)}/usage/api/incurred`;

  const response = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(`usage.incurred ingest failed: ${response.status} ${await parseErrorMessage(response)}`);
  }

  return response.json() as Promise<IngestResponse>;
}
