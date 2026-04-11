import { NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

// Opportunistic cleanup — at most once per hour
let lastCleanupAt = 0;

async function runCleanup(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = now;
  await sql`
    DELETE FROM registry.request_log
    WHERE created_at < now() - interval '30 days'
  `;
}

export const GET = withLogger('kernel', async (_req, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fire-and-forget cleanup
  runCleanup().catch(() => {});

  const [volumeRows, latencyRows, errorRateRows, slowestRows] = await Promise.all([
    // Request volume per hour (last 24h)
    sql`
      SELECT
        date_trunc('hour', created_at) AS hour,
        COUNT(*)::int AS count
      FROM registry.request_log
      WHERE created_at >= now() - interval '24 hours'
      GROUP BY 1
      ORDER BY 1
    `,
    // p50/p95/p99 latency per endpoint
    sql`
      SELECT
        path,
        method,
        COUNT(*)::int AS total_requests,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99
      FROM registry.request_log
      WHERE created_at >= now() - interval '24 hours'
        AND duration_ms IS NOT NULL
      GROUP BY path, method
      ORDER BY p95 DESC
      LIMIT 50
    `,
    // Error rates per endpoint
    sql`
      SELECT
        path,
        method,
        COUNT(*)::int AS total_requests,
        COUNT(*) FILTER (WHERE status >= 400)::int AS error_count,
        ROUND(COUNT(*) FILTER (WHERE status >= 400) * 100.0 / COUNT(*), 1) AS error_rate
      FROM registry.request_log
      WHERE created_at >= now() - interval '24 hours'
      GROUP BY path, method
      HAVING COUNT(*) > 0
      ORDER BY error_rate DESC, total_requests DESC
      LIMIT 50
    `,
    // Top 10 slowest endpoints (by p95)
    sql`
      SELECT
        path,
        method,
        COUNT(*)::int AS total_requests,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
        MAX(duration_ms)::int AS max_ms
      FROM registry.request_log
      WHERE created_at >= now() - interval '24 hours'
        AND duration_ms IS NOT NULL
      GROUP BY path, method
      ORDER BY p95 DESC
      LIMIT 10
    `,
  ]);

  log.info({ volumeHours: volumeRows.length }, 'telemetry stats fetched');

  return NextResponse.json({
    volume: volumeRows,
    latency: latencyRows,
    errorRates: errorRateRows,
    slowest: slowestRows,
  });
});
