import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, bugReports } from '@/src/db';
import type { BugReport } from '@/src/db';
import { eq, desc, and, notInArray, inArray } from 'drizzle-orm';
import { BugReporterOpenButton } from '@/src/components/www/BugReporterOpenButton';
import { getSessionFromCookies } from '@/src/lib/kernel/session';

const STATUS_STYLES: Record<string, string> = {
  new: 'bg-gray-700 text-gray-300',
  reviewed: 'bg-blue-900 text-blue-300',
  imported: 'bg-green-900 text-green-300',
  ignored: 'bg-red-900 text-red-300',
  duplicate: 'bg-yellow-900 text-yellow-300',
  resolved: 'bg-emerald-900 text-emerald-300',
};

const CLOSED_STATUSES = ['resolved', 'ignored', 'duplicate'];

const TYPE_EMOJI: Record<string, string> = {
  bug: '🐛',
  suggestion: '💡',
  question: '❓',
  other: '💬',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-gray-700 text-gray-300'}`}>
      {status}
    </span>
  );
}

function formatDate(date: Date | string | null) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function ReportCard({ r }: { r: BugReport }) {
  return (
    <li className="rounded-xl border border-gray-800 bg-[#111] p-5">
      <div className="flex items-start gap-4">
        {r.screenshotUrl && (
          <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={r.screenshotUrl}
              alt="Screenshot"
              className="h-16 w-16 rounded object-cover border border-gray-700"
            />
          </a>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 line-clamp-3 mb-2">{r.description}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="inline-flex items-center px-2 py-0.5 rounded font-medium bg-gray-700 text-gray-300">
              {TYPE_EMOJI[r.type] ?? '🐛'}
            </span>
            <StatusBadge status={r.status} />
            <span>{formatDate(r.createdAt)}</span>
            {r.status === 'imported' && r.githubIssueUrl && (
              <a
                href={r.githubIssueUrl}
                target="_blank"
                rel="noreferrer"
                className="text-orange-400 hover:text-orange-300 transition-colors"
              >
                #{r.githubIssueNumber} on GitHub →
              </a>
            )}
            {r.status === 'duplicate' && r.duplicateOf && (
              <span className="text-yellow-500">Duplicate of {r.duplicateOf}</span>
            )}
            {r.pageUrl && (
              <span className="truncate max-w-[200px]" title={r.pageUrl}>
                📍 {r.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/'}
              </span>
            )}
            {r.viewport && (
              <span>📐 {r.viewport}</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

interface PageProps {
  searchParams: Promise<{ filter?: string }>;
}

export default async function BugsPage({ searchParams }: PageProps) {
  const cookieStore = await cookies();
  const session = await getSessionFromCookies(cookieStore.toString());
  if (!session) redirect('/');

  const { filter: filterParam } = await searchParams;
  const filter = filterParam === 'closed' ? 'closed' : filterParam === 'all' ? 'all' : 'open';

  // Build status filter
  const statusFilter = filter === 'open'
    ? notInArray(bugReports.status, CLOSED_STATUSES)
    : filter === 'closed'
    ? inArray(bugReports.status, CLOSED_STATUSES)
    : undefined;

  const [myReports, allReports] = await Promise.all([
    db.select().from(bugReports).where(
      statusFilter
        ? and(eq(bugReports.reporterDid, session.did), statusFilter)
        : eq(bugReports.reporterDid, session.did)
    ).orderBy(desc(bugReports.createdAt)),
    db.select().from(bugReports).where(statusFilter ?? undefined).orderBy(desc(bugReports.createdAt)),
  ]);

  // Others' reports = all reports minus mine (strip reporter details for privacy)
  const otherReports = allReports
    .filter(r => r.reporterDid !== session.did)
    .map(r => ({ ...r, reporterDid: 'anonymous', reporterName: null }));

  return (
    <main className="min-h-screen px-6 py-12 max-w-3xl mx-auto">
      {/* Header with report button */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-100 mb-1">Bug Reports</h1>
          <p className="text-sm text-gray-500">
            {allReports.length} report{allReports.length !== 1 ? 's' : ''}{filter !== 'all' ? ` (${filter})` : ''}
          </p>
        </div>
        <BugReporterOpenButton />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {(['open', 'closed', 'all'] as const).map((f) => (
          <Link
            key={f}
            href={f === 'open' ? '/bugs' : `/bugs?filter=${f}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === f
                ? 'bg-orange-500 text-white'
                : 'bg-[#1a1a1a] text-gray-400 hover:text-gray-200 border border-gray-700'
            }`}
          >
            {f === 'open' ? '🔴 Open' : f === 'closed' ? '✅ Closed' : '📋 All'}
          </Link>
        ))}
      </div>

      {/* My Reports */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-200 mb-4">My Reports</h2>
        {myReports.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-[#111] px-6 py-8 text-center">
            <p className="text-gray-500">
              {filter === 'open' ? "You don't have any open reports." : filter === 'closed' ? "No closed reports." : "You haven't reported anything yet."}
            </p>
            {filter === 'open' && (
              <p className="text-sm text-gray-600 mt-1">
                Found something off? Hit the button above or use the 🐛 in the bottom-right corner.
              </p>
            )}
          </div>
        ) : (
          <ul className="space-y-4">
            {myReports.map((r) => <ReportCard key={r.id} r={r} />)}
          </ul>
        )}
      </section>

      {/* All Reported Issues */}
      <section>
        <h2 className="text-lg font-semibold text-gray-200 mb-4">All Reported Issues</h2>
        {otherReports.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-[#111] px-6 py-8 text-center">
            <p className="text-gray-500">No {filter !== 'all' ? filter : 'other'} reports from others.</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {otherReports.map((r) => <ReportCard key={r.id} r={r} />)}
          </ul>
        )}
      </section>

      <div className="mt-8">
        <Link href="/" className="text-orange-400 hover:text-orange-300 text-sm transition-colors">
          ← Back to home
        </Link>
      </div>
    </main>
  );
}
