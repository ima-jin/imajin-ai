import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { BugReport } from '@/db/schema';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
import { SESSION_COOKIE_NAME as SESSION_COOKIE } from '@imajin/config';

async function getSession() {
  const cookieStore = cookies();
  const session = cookieStore.get(SESSION_COOKIE);
  if (!session) return null;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE}=${session.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ did: string; name?: string; tier?: string }>;
  } catch {
    return null;
  }
}

async function getBugReports(sessionCookieValue: string, scope?: string): Promise<BugReport[]> {
  try {
    const url = scope
      ? `${process.env.NEXT_PUBLIC_WWW_URL || 'http://localhost:3000'}/api/bugs?scope=${scope}`
      : `${process.env.NEXT_PUBLIC_WWW_URL || 'http://localhost:3000'}/api/bugs`;
    const res = await fetch(url, {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionCookieValue}` },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

const STATUS_STYLES: Record<string, string> = {
  new: 'bg-gray-700 text-gray-300',
  reviewed: 'bg-blue-900 text-blue-300',
  imported: 'bg-green-900 text-green-300',
  ignored: 'bg-red-900 text-red-300',
  duplicate: 'bg-yellow-900 text-yellow-300',
};

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
          </div>
        </div>
      </div>
    </li>
  );
}

export default async function BugsPage() {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);
  if (!sessionCookie) redirect('/');

  const session = await getSession();
  if (!session) redirect('/');

  const [myReports, allReports] = await Promise.all([
    getBugReports(sessionCookie.value),
    getBugReports(sessionCookie.value, 'all'),
  ]);

  // Others' reports = all reports minus mine
  const otherReports = allReports.filter(r => r.reporterDid !== session.did);

  return (
    <main className="min-h-screen px-6 py-12 max-w-3xl mx-auto">
      {/* Header with report button */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-100 mb-1">Bug Reports</h1>
          <p className="text-sm text-gray-500">
            {allReports.length} total report{allReports.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          id="open-bug-reporter"
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          🐛 Report a Bug
        </button>
      </div>

      {/* Script to trigger the floating bug reporter */}
      <script dangerouslySetInnerHTML={{ __html: `
        document.getElementById('open-bug-reporter')?.addEventListener('click', function() {
          var btn = document.querySelector('[data-bug-reporter-trigger]');
          if (btn) btn.click();
          else alert('Bug reporter is loading — try again in a moment.');
        });
      `}} />

      {/* My Reports */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-200 mb-4">My Reports</h2>
        {myReports.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-[#111] px-6 py-8 text-center">
            <p className="text-gray-500">You haven't reported anything yet.</p>
            <p className="text-sm text-gray-600 mt-1">
              Found something off? Hit the button above or use the 🐛 in the bottom-right corner.
            </p>
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
            <p className="text-gray-500">No other reports yet.</p>
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
