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
    conditions.push(`(i.handle ILIKE $${idx} OR i.name ILIKE $${idx} OR p.display_name ILIKE $${idx} OR i.contact_email ILIKE $${idx} OR p.contact_email ILIKE $${idx})`);
    binds.push(`%${q}%`);
    idx++;
  }
  if (tier) {
    conditions.push(`i.tier = $${idx}`);
    binds.push(tier);
    idx++;
  }
  if (type) {
    conditions.push(`i.scope = $${idx}`);
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
       i.scope,
       i.subtype,
       i.tier,
       i.suspended_at,
       i.created_at,
       i.contact_email,
       p.display_name,
       p.contact_email AS profile_email
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Users</h1>
        <p className="mt-1 text-sm text-secondary dark:text-secondary">
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
          className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-52"
        />
        <select
          name="tier"
          defaultValue={tier}
          className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
        >
          <option value="">All tiers</option>
          <option value="soft">Soft</option>
          <option value="preliminary">Preliminary</option>
          <option value="established">Established</option>
          <option value="steward">Steward</option>
          <option value="operator">Operator</option>
        </select>
        <select
          name="type"
          defaultValue={type}
          className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
        >
          <option value="">All scopes</option>
          <option value="actor">Actor</option>
          <option value="family">Family</option>
          <option value="community">Community</option>
          <option value="business">Business</option>
        </select>
        <button
          type="submit"
          style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-3 py-1.5 text-sm font-medium"
        >
          Filter
        </button>
        {(q || tier || type) && (
          <Link
            href="/admin/users"
            className="text-sm text-secondary dark:text-secondary hover:text-gray-700 dark:hover:text-primary"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Table */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">
            No users found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Handle</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Email</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Scope</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Tier</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
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
                      className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/users/${encodeURIComponent(did)}`}
                          className="font-mono text-imajin-orange dark:text-imajin-orange hover:underline text-xs"
                        >
                          {handle ? `@${handle}` : did.slice(0, 20) + '…'}
                        </Link>
                        {isSuspended && (
                          <span className="ml-2 text-xs bg-error/10 dark:bg-error/40 text-error dark:text-error px-1.5 py-0.5 ">
                            suspended
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-primary">
                        {name ?? <span className="text-secondary dark:text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary dark:text-secondary truncate max-w-[180px]" title={(row.profile_email || row.contact_email) as string || ''}>
                        {(row.profile_email || row.contact_email) as string || <span className="text-secondary dark:text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary px-2 py-0.5 ">
                          {row.scope as string}
                        </span>
                        {row.subtype && (
                          <span className="ml-1 text-xs text-secondary dark:text-secondary">
                            {row.subtype as string}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <TierBadge tier={row.tier as string} />
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap">
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
            className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated"
          >
            ← Previous
          </Link>
        ) : (
          <span className="border border-gray-200 dark:border-white/10 px-3 py-1.5 text-sm text-secondary dark:text-muted cursor-not-allowed">
            ← Previous
          </span>
        )}
        <span className="text-sm text-secondary dark:text-secondary">
          Page {page}
        </span>
        {hasNext ? (
          <Link
            href={buildUrl({ page: String(page + 1) })}
            className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated"
          >
            Next →
          </Link>
        ) : (
          <span className="border border-gray-200 dark:border-white/10 px-3 py-1.5 text-sm text-secondary dark:text-muted cursor-not-allowed">
            Next →
          </span>
        )}
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    soft: 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary',
    preliminary: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    established: 'bg-success/10 dark:bg-success/40 text-success dark:text-success',
    steward: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
    operator: 'bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange',
  };
  return (
    <span className={`text-xs px-2 py-0.5  ${styles[tier] ?? styles.soft}`}>
      {tier}
    </span>
  );
}
