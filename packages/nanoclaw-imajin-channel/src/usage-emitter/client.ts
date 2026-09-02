/**
 * Kernel ingest client (imajin-ai#1932, #1151) — posts batches to
 * `POST /usage/api/incurred`. Same shape as
 * `packages/usage-emitter-claude-code/src/client.ts`; not imported (that
 * package exports only its top-level CLI), re-implemented here.
 *
 * Auth is a bearer app-service token read from the environment
 * (`USAGE_EMIT_TOKEN`) — `usage:emit` is `serviceEligible: true`
 * (`@imajin/auth`'s `SCOPE_VOCABULARY`), so a session-less app-service token
 * can carry it, matching the reference emitter's own design note on why this
 * is meant to be invoked periodically (cron/systemd timer) rather than run
 * as a long-lived daemon needing its own refresh loop.
 */
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

export function chunkRows<T>(rows: readonly T[], size: number = MAX_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export async function postIncurredBatch(config: ClientConfig, rows: readonly MappedUsageRow[]): Promise<IngestResponse> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.kernelUrl.replace(/\/$/, '')}/usage/api/incurred`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(`usage.incurred ingest failed: ${res.status} ${body.error ?? res.statusText}`);
  }

  return res.json() as Promise<IngestResponse>;
}
