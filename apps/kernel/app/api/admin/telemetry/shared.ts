import { getClient } from '@imajin/db';

const sql = getClient();
const REQUEST_SELECT = `
  SELECT
    id, service, method, path, status, duration_ms, did, ip,
    correlation_id, error_message, created_at
  FROM registry.logs
  WHERE source = 'request'
`;

export function parseTelemetryPagination(url: string) {
  const { searchParams } = new URL(url);
  return {
    limit: Math.min(Number(searchParams.get('limit') ?? '50'), 200),
    offset: Number(searchParams.get('offset') ?? '0'),
  };
}

export async function fetchTelemetryRequests(kind: 'errors' | 'slow', limit: number, offset: number) {
  if (kind === 'errors') {
    const rows = await sql.unsafe(
      `${REQUEST_SELECT} AND status >= 400 ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const [countRow] = await sql`SELECT COUNT(*)::int AS count FROM registry.logs WHERE source = 'request' AND status >= 400`;
    return { rows, total: countRow?.count ?? 0, logLabel: 'error requests fetched' };
  }

  const rows = await sql.unsafe(
    `${REQUEST_SELECT} AND duration_ms >= 1000 ORDER BY duration_ms DESC, created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const [countRow] = await sql`SELECT COUNT(*)::int AS count FROM registry.logs WHERE source = 'request' AND duration_ms >= 1000`;
  return { rows, total: countRow?.count ?? 0, logLabel: 'slow requests fetched' };
}
