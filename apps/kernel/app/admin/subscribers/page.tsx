import { getClient } from '@imajin/db';
import { getSession } from '@imajin/auth';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import CreateList from './create-list';
import SubscriberActions from './subscriber-actions';

const sql = getClient();
const PAGE_SIZE = 25;

interface SearchParams {
  q?: string;
  list?: string;
  verified?: string;
  page?: string;
}

async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) redirect('/admin');
  const nodeDid = process.env.NODE_DID;
  if (!nodeDid || session.actingAs !== nodeDid) redirect('/admin');
  return session;
}

export default async function AdminSubscribersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAdmin();
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const listSlug = params.list ?? '';
  const verified = params.verified ?? '';
  const page = Math.max(1, parseInt(params.page ?? '1', 10));
  const offset = (page - 1) * PAGE_SIZE;

  // Stats
  const [statsRow] = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE c.is_verified = TRUE) AS verified,
      COUNT(*) FILTER (WHERE c.is_verified = FALSE) AS unverified
    FROM www.contacts c
    JOIN www.subscriptions s ON c.id = s.contact_id
    WHERE s.status = 'subscribed'
  `;
  const totalSubs = Number(statsRow?.total ?? 0);
  const verifiedCount = Number(statsRow?.verified ?? 0);
  const unverifiedCount = Number(statsRow?.unverified ?? 0);

  // Mailing lists
  const lists = await sql`
    SELECT
      ml.id,
      ml.slug,
      ml.name,
      ml.description,
      ml.is_active,
      COUNT(s.id) FILTER (WHERE s.status = 'subscribed') AS subscriber_count
    FROM www.mailing_lists ml
    LEFT JOIN www.subscriptions s ON s.mailing_list_id = ml.id
    WHERE ml.owner_did IS NULL OR ml.owner_did = ${session.actingAs}
    GROUP BY ml.id
    ORDER BY ml.created_at ASC
  `;

  // Subscribers query
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`c.email ILIKE $${idx}`);
    binds.push(`%${q}%`);
    idx++;
  }
  if (verified === 'true') {
    conditions.push('c.is_verified = TRUE');
  } else if (verified === 'false') {
    conditions.push('c.is_verified = FALSE');
  }
  if (listSlug) {
    conditions.push(`ml.slug = $${idx}`);
    binds.push(listSlug);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRow] = await sql.unsafe(
    `SELECT COUNT(*) AS total
     FROM www.contacts c
     JOIN www.subscriptions s ON c.id = s.contact_id
     JOIN www.mailing_lists ml ON ml.id = s.mailing_list_id
     ${whereClause}`,
    binds as string[]
  );
  const total = Number(countRow?.total ?? 0);

  const rows = await sql.unsafe(
    `SELECT
       c.id,
       c.email,
       c.source,
       c.is_verified,
       c.verified_at,
       s.status,
       s.subscribed_at,
       ml.slug AS list_slug,
       ml.name AS list_name
     FROM www.contacts c
     JOIN www.subscriptions s ON c.id = s.contact_id
     JOIN www.mailing_lists ml ON ml.id = s.mailing_list_id
     ${whereClause}
     ORDER BY s.subscribed_at DESC
     LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    binds as string[]
  );

  const hasNext = rows.length === PAGE_SIZE;
  const hasPrev = page > 1;

  function buildUrl(overrides: Partial<SearchParams>) {
    const p: Record<string, string> = {};
    if (q) p.q = q;
    if (listSlug) p.list = listSlug;
    if (verified) p.verified = verified;
    p.page = String(page);
    Object.assign(p, overrides);
    return `/admin/subscribers?${new URLSearchParams(p).toString()}`;
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Subscribers</h1>
          <p className="mt-1 text-sm text-secondary dark:text-secondary">
            Manage mailing lists and subscribers
          </p>
        </div>
        <a
          href={`/api/admin/subscribers/export${listSlug ? `?list=${listSlug}` : ''}`}
          className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated"
        >
          Export CSV
        </a>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Subscribers', value: totalSubs.toLocaleString() },
          { label: 'Verified', value: verifiedCount.toLocaleString() },
          { label: 'Unverified', value: unverifiedCount.toLocaleString() },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-4"
          >
            <p className="text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">
              {stat.label}
            </p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-primary">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Mailing Lists */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-primary font-mono">Mailing Lists</h2>
          <CreateList />
        </div>
        {lists.length === 0 ? (
          <p className="text-sm text-secondary dark:text-secondary">No mailing lists yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {lists.map((list) => (
              <Link
                key={list.id as string}
                href={`/admin/subscribers?list=${list.slug}`}
                className={`bg-white dark:bg-surface-elevated border p-4 transition-colors hover:border-imajin-orange/30 dark:hover:border-imajin-orange/30 ${
                  listSlug === (list.slug as string)
                    ? 'border-imajin-orange dark:border-imajin-orange'
                    : 'border-gray-100 dark:border-white/10'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-gray-900 dark:text-primary text-sm">{list.name as string}</p>
                    {list.description && (
                      <p className="text-xs text-secondary dark:text-secondary mt-0.5 line-clamp-2">
                        {list.description as string}
                      </p>
                    )}
                  </div>
                  <span className="ml-2 text-xs bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange px-2 py-0.5 font-medium whitespace-nowrap">
                    {Number(list.subscriber_count).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-xs text-secondary dark:text-muted font-mono">{list.slug as string}</p>
              </Link>
            ))}
          </div>
        )}
        {listSlug && (
          <div className="mt-2">
            <Link href="/admin/subscribers" className="text-sm text-secondary dark:text-secondary hover:underline">
              ← Show all lists
            </Link>
          </div>
        )}
      </div>

      {/* Filters */}
      <form method="GET" action="/admin/subscribers" className="mb-4 flex flex-wrap gap-2 items-center">
        {listSlug && <input type="hidden" name="list" value={listSlug} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search email…"
          className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-52"
        />
        <select
          name="verified"
          defaultValue={verified}
          className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
        >
          <option value="">All</option>
          <option value="true">Verified</option>
          <option value="false">Unverified</option>
        </select>
        <button
          type="submit"
          style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-3 py-1.5 text-sm font-medium"
        >
          Filter
        </button>
        {(q || verified) && (
          <Link
            href={listSlug ? `/admin/subscribers?list=${listSlug}` : '/admin/subscribers'}
            className="text-sm text-secondary dark:text-secondary hover:text-gray-700 dark:hover:text-primary"
          >
            Clear
          </Link>
        )}
        <span className="ml-auto text-sm text-secondary dark:text-secondary">
          {total.toLocaleString()} subscriber{total !== 1 ? 's' : ''}
        </span>
      </form>

      {/* Subscribers Table */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">
            No subscribers found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Email</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Source</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Verified</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Subscribed</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">List</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {rows.map((row) => {
                  const subscribedAt = row.subscribed_at ? new Date(row.subscribed_at as string) : null;
                  const relTime = subscribedAt
                    ? formatDistanceToNow(subscribedAt, { addSuffix: true })
                    : '—';
                  return (
                    <tr key={`${row.id}-${row.list_slug}`} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-primary">{row.email as string}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary px-2 py-0.5 ">
                          {row.source as string}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {row.is_verified ? (
                          <span className="text-success dark:text-success">✓</span>
                        ) : (
                          <span className="text-secondary dark:text-muted">✗</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap">
                        {relTime}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5  ${
                          row.status === 'subscribed'
                            ? 'bg-success/10 dark:bg-success/40 text-success dark:text-success'
                            : 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary'
                        }`}>
                          {row.status as string}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary dark:text-secondary font-mono">
                        {row.list_slug as string}
                      </td>
                      <td className="px-4 py-3">
                        <SubscriberActions
                          id={row.id as string}
                          email={row.email as string}
                          isVerified={row.is_verified as boolean}
                        />
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
          <Link href={buildUrl({ page: String(page - 1) })} className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated">
            ← Previous
          </Link>
        ) : (
          <span className="border border-gray-200 dark:border-white/10 px-3 py-1.5 text-sm text-secondary dark:text-muted cursor-not-allowed">
            ← Previous
          </span>
        )}
        <span className="text-sm text-secondary dark:text-secondary">Page {page}</span>
        {hasNext ? (
          <Link href={buildUrl({ page: String(page + 1) })} className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated">
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
