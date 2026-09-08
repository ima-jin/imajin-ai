import type { getClient } from '@imajin/db';

type SqlClient = ReturnType<typeof getClient>;

export interface LogFilters {
  service: string | null;
  levels: string[] | null;
  source: string | null;
  correlationId: string | null;
  did: string | null;
  searchPattern: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
}

/** Parse the admin logs query params into a typed filter set. */
export function parseLogFilters(url: URL): LogFilters {
  const search = url.searchParams.get('search') || null;
  const levelParam = url.searchParams.get('level') || null;

  return {
    service: url.searchParams.get('service') || null,
    levels: levelParam ? levelParam.split(',').filter(Boolean) : null,
    source: url.searchParams.get('source') || null,
    correlationId: url.searchParams.get('correlationId') || null,
    did: url.searchParams.get('did') || null,
    searchPattern: search ? `%${search}%` : null,
    from: url.searchParams.get('from') || null,
    to: url.searchParams.get('to') || null,
    limit: Math.min(200, Number.parseInt(url.searchParams.get('limit') || '50', 10)),
    offset: Number.parseInt(url.searchParams.get('offset') || '0', 10),
  };
}

/**
 * Build the shared WHERE fragment for the admin logs count + list queries.
 * Previously this ternary chain was duplicated verbatim across both queries
 * inline in the route, doubling its cognitive weight — now it lives in one
 * place and is invoked once per query.
 */
export function buildLogsWhereFragment(sql: SqlClient, filters: LogFilters) {
  const { service, levels, source, correlationId, did, searchPattern, from, to } = filters;
  return sql`
    ${service ? sql`AND service = ${service}` : sql``}
    ${levels && levels.length > 0 ? sql`AND level = ANY(${levels})` : sql``}
    ${source ? sql`AND source = ${source}` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${searchPattern ? sql`AND (message ILIKE ${searchPattern} OR path ILIKE ${searchPattern} OR error_message ILIKE ${searchPattern})` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
  `;
}
