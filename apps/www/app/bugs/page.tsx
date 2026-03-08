import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { BugReport } from '@/db/schema';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const SESSION_COOKIE = 'imajin_session';

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

async function getBugReports(sessionCookieValue: string): Promise<BugReport[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_WWW_URL || 'http://localhost:3000'}/api/bugs`, {
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

export default async function BugsPage() {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);
  if (!sessionCookie) redirect('/');

  const session = await getSession();
  if (!session) redirect('/');

  const reports = await getBugReports(sessionCookie.value);

  return (
    <main className="min-h-screen px-6 py-12 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100 mb-1">My Bug Reports</h1>
        <p className="text-sm text-gray-500">
          {reports.length} report{reports.length !== 1 ? 's' : ''}
        </p>
      </div>

      {reports.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-[#111] px-6 py-12 text-center">
          <p className="text-gray-500">No bug reports yet.</p>
          <p className="text-sm text-gray-600 mt-1">Use the 🐛 button to report an issue.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {reports.map((r) => (
            <li key={r.id} className="rounded-xl border border-gray-800 bg-[#111] p-5">
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
                      {r.type === 'suggestion' ? '💡' : r.type === 'question' ? '❓' : r.type === 'other' ? '💬' : '🐛'}
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
          ))}
        </ul>
      )}

      <div className="mt-8">
        <Link href="/" className="text-orange-400 hover:text-orange-300 text-sm transition-colors">
          ← Back to home
        </Link>
      </div>
    </main>
  );
}
