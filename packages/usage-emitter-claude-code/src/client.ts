/**
 * Kernel ingest client (#1151) — posts batches to `POST /usage/api/incurred`.
 *
 * Uses the platform `fetch` global (Node 18+) — no HTTP client dependency.
 * Auth is a bearer app-token JWT read from the environment (`USAGE_EMIT_TOKEN`),
 * not minted here. See the package README for why: app tokens are short-lived
 * (~10 min, docs/guide/service-credentials.md), so this reference adapter is
 * meant to be invoked periodically (cron/systemd timer) with a freshly minted
 * token each run, rather than run as a long-lived daemon that would need its
 * own refresh loop.
 */
import type { MappedUsageRow } from './mapper';

/** Ceiling matching the kernel's own `MAX_INCURRED_BATCH_SIZE`; kept in sync manually, not imported cross-package. */
export const MAX_BATCH_SIZE = 500;

export interface ClientConfig {
  kernelUrl: string;
  token: string;
}

export interface IngestResponse {
  inserted: number;
  skipped: number;
  rejected: Array<{ index: number; reason: string }>;
}

/** Split `rows` into chunks no larger than `MAX_BATCH_SIZE`. */
export function chunkRows<T>(rows: readonly T[], size: number = MAX_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/** POST one batch of rows. Throws on a non-2xx response. */
export async function postIncurredBatch(config: ClientConfig, rows: readonly MappedUsageRow[]): Promise<IngestResponse> {
  const url = `${config.kernelUrl.replace(/\/$/, '')}/usage/api/incurred`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(`usage.incurred ingest failed: ${res.status} ${body.error ?? res.statusText}`);
  }

  return res.json() as Promise<IngestResponse>;
}
