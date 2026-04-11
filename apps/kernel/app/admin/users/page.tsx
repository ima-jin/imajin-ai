import { getClient } from '@imajin/db';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';

const sql = getClient();
const PAGE_SIZE = 25;

interface SearchParams {
  q?: string;
  tier?: string;
  type?: string;
  page?: string;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const tier = params.tier ?? '';
  const type = params.type ?? '';
  const page = Math.max(1, parseInt(params.page ?? '1', 10));
  const offset = (page - 1) * PAGE_SIZE;

  // Build filter conditions
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`(i.handle ILIKE $${idx} OR i.name ILIKE $${idx} OR p.display_name ILIKE $${idx})`);
    binds.push(`%${q}%`);
    idx++;
  }
  if (tier) {
    conditions.push(`i.tier = $${idx}`);
    binds.push(tier);
    idx++;
  }
  if (type) {
    conditions.push(`i.type = $${idx}`);
    binds.push(type);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = await sql.unsafe(
    `SELECT COUNT(*) AS total
     FROM auth.identities i
     LEFT JOIN profile.profiles p ON i.id = p.did
     ${whereClause}`,
    binds as string[]
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await sql.unsafe(
    `SELECT
       i.id,
       i.handle,
       i.name,
       i.type,
       i.tier,
       i.suspended_at,
       i.created_at,
       p.display_name
     FROM auth.identities i
     LEFT JOIN profile.profiles p ON i.id = p.did
     ${whereClause}
     ORDER BY i.created_at DESC
     LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    binds as string[]
  );

  const hasNext = rows.length === PAGE_SIZE;
  const hasPrev = page > 1;

  function buildUrl(overrides: Partial<SearchParams>) {
    const p: Record<string, string> = {};
    if (q) p.q = q;
    if (tier) p.tier = tier;
    if (type) p.type = type;
    p.page = String(page);
    Object.assign(p, overrides);
    const qs = new URLSearchParams(p).toString();
    return `/admin/users?${qs}`;
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Users</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {total.toLocaleString()} total identities
        </p>
      </div>

      {/* Filters */}
      <form method="GET" action="/admin/users" className="mb-4 flex flex-wrap gap-2 items-center">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search handle or name…"
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 w-52"
        />
        <select
          name="tier"
          defaultValue={tier}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
          <option value="">All tiers</option>
          <option value="soft">Soft</option>
          <option value="preliminary">Preliminary</option>
          <option value="established">Established</option>
        </select>
        <select
          name="type"
          defaultValue={type}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
          <option value="">All types</option>
          <option value="human">Human</option>
          <option value="agent">Agent</option>
          <option value="event">Event</option>
          <option value="service">Service</option>
          <option value="node">Node</option>
        </select>
        <button
          type="submit"
          className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium"
        >
          Filter
        </button>
        {(q || tier || type) && (
          <Link
            href="/admin/users"
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Table */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
            No users found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Handle</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tier</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {rows.map((row) => {
                  const did = row.id as string;
                  const handle = row.handle as string | null;
                  const name = (row.display_name ?? row.name) as string | null;
                  const createdAt = row.created_at as Date;
                  const isSuspended = !!row.suspended_at;
                  const relTime = createdAt
                    ? formatDistanceToNow(new Date(createdAt), { addSuffix: true })
                    : '—';

                  return (
                    <tr
                      key={did}
                      className="hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/users/${encodeURIComponent(did)}`}
                          className="font-mono text-orange-600 dark:text-orange-400 hover:underline text-xs"
                        >
                          {handle ? `@${handle}` : did.slice(0, 20) + '…'}
                        </Link>
                        {isSuspended && (
                          <span className="ml-2 text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded">
                            suspended
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {name ?? <span className="text-gray-400 dark:text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded">
                          {row.type as string}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <TierBadge tier={row.tier as string} />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {relTime}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center gap-3">
        {hasPrev ? (
          <Link
            href={buildUrl({ page: String(page - 1) })}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            ← Previous
          </Link>
        ) : (
          <span className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-400 dark:text-gray-600 cursor-not-allowed">
            ← Previous
          </span>
        )}
        <span className="text-sm text-gray-500 dark:text-gray-400">
          Page {page}
        </span>
        {hasNext ? (
          <Link
            href={buildUrl({ page: String(page + 1) })}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Next →
          </Link>
        ) : (
          <span className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-400 dark:text-gray-600 cursor-not-allowed">
            Next →
          </span>
        )}
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    soft: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
    preliminary: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    established: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[tier] ?? styles.soft}`}>
      {tier}
    </span>
  );
}
