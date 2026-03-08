'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { BugReport } from '@/db/schema';

const STATUSES = ['all', 'new', 'reviewed', 'imported', 'ignored', 'duplicate'] as const;
type StatusFilter = typeof STATUSES[number];

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
  return new Date(date).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

interface IgnoreState {
  id: string;
  notes: string;
}

interface DuplicateState {
  id: string;
  duplicateOf: string;
}

export default function AdminBugsPage() {
  const [reports, setReports] = useState<BugReport[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('new');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ignoreState, setIgnoreState] = useState<IgnoreState | null>(null);
  const [duplicateState, setDuplicateState] = useState<DuplicateState | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchReports = useCallback(async (status: StatusFilter) => {
    setLoading(true);
    setError('');
    try {
      const url = status === 'all' ? '/api/bugs/admin' : `/api/bugs/admin?status=${status}`;
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        setError('Access denied. Admin only.');
        return;
      }
      if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
      setReports(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReports(filter); }, [filter, fetchReports]);

  const importToGitHub = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/bugs/${id}/import`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || 'Import failed');
      }
      await fetchReports(filter);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setActionLoading(null);
    }
  };

  const patchReport = async (id: string, patch: Record<string, string>) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/bugs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || 'Update failed');
      }
      await fetchReports(filter);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setActionLoading(null);
      setIgnoreState(null);
      setDuplicateState(null);
    }
  };

  return (
    <main className="min-h-screen px-6 py-12 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100 mb-1">Bug Reports — Admin</h1>
        <Link href="/bugs" className="text-sm text-orange-400 hover:text-orange-300 transition-colors">
          ← My reports
        </Link>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === s
                ? 'bg-orange-500 text-white'
                : 'bg-[#1a1a1a] text-gray-400 hover:text-gray-200 border border-gray-700'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/40 px-5 py-4 text-sm text-red-400 mb-6">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-[#111] px-6 py-12 text-center">
          <p className="text-gray-500">No reports{filter !== 'all' ? ` with status "${filter}"` : ''}.</p>
        </div>
      ) : (
        <ul className="space-y-5">
          {reports.map((r) => {
            const busy = actionLoading === r.id;
            return (
              <li key={r.id} className="rounded-xl border border-gray-800 bg-[#111] p-5">
                {/* Header */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <StatusBadge status={r.status} />
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-700 text-gray-300">
                    {r.type === 'suggestion' ? '💡 Suggestion' : r.type === 'question' ? '❓ Question' : r.type === 'other' ? '💬 Other' : '🐛 Bug'}
                  </span>
                  <span className="text-xs text-gray-500">{r.id}</span>
                  <span className="text-xs text-gray-600">{formatDate(r.createdAt)}</span>
                </div>

                {/* Reporter info */}
                <div className="text-xs text-gray-500 mb-2 space-y-0.5">
                  {r.reporterName && <p><span className="text-gray-400">Name:</span> {r.reporterName}</p>}
                  <p><span className="text-gray-400">DID:</span> <span className="font-mono">{r.reporterDid}</span></p>
                  {r.pageUrl && <p><span className="text-gray-400">Page:</span> {r.pageUrl}</p>}
                  {r.viewport && <p><span className="text-gray-400">Viewport:</span> {r.viewport}</p>}
                  {r.userAgent && <p className="truncate"><span className="text-gray-400">UA:</span> {r.userAgent}</p>}
                </div>

                {/* Description */}
                <p className="text-sm text-gray-200 whitespace-pre-wrap mb-3">{r.description}</p>

                {/* Screenshot */}
                {r.screenshotUrl && (
                  <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="inline-block mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.screenshotUrl}
                      alt="Screenshot"
                      className="max-h-40 rounded border border-gray-700 object-contain"
                    />
                  </a>
                )}

                {/* GitHub link */}
                {r.githubIssueUrl && (
                  <p className="text-xs mb-3">
                    <a href={r.githubIssueUrl} target="_blank" rel="noreferrer" className="text-orange-400 hover:text-orange-300">
                      GitHub #{r.githubIssueNumber} →
                    </a>
                  </p>
                )}

                {/* Admin notes */}
                {r.adminNotes && (
                  <p className="text-xs text-gray-500 mb-3 italic">Notes: {r.adminNotes}</p>
                )}

                {/* Duplicate of */}
                {r.duplicateOf && (
                  <p className="text-xs text-yellow-500 mb-3">Duplicate of: {r.duplicateOf}</p>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-800">
                  {r.status !== 'imported' && (
                    <button
                      onClick={() => importToGitHub(r.id)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg text-xs bg-green-900 hover:bg-green-800 text-green-300 transition-colors disabled:opacity-50"
                    >
                      Import to GitHub
                    </button>
                  )}

                  {r.status !== 'ignored' && (
                    ignoreState?.id === r.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={ignoreState.notes}
                          onChange={(e) => setIgnoreState({ id: r.id, notes: e.target.value })}
                          placeholder="Reason (optional)"
                          className="rounded bg-[#1a1a1a] border border-gray-700 text-gray-200 text-xs px-2 py-1 focus:outline-none focus:border-orange-500"
                        />
                        <button
                          onClick={() => patchReport(r.id, { status: 'ignored', adminNotes: ignoreState.notes })}
                          disabled={busy}
                          className="px-3 py-1.5 rounded-lg text-xs bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setIgnoreState(null)}
                          className="text-xs text-gray-500 hover:text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setIgnoreState({ id: r.id, notes: '' })}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-lg text-xs bg-[#1a1a1a] hover:bg-red-950 text-red-400 border border-gray-700 transition-colors disabled:opacity-50"
                      >
                        Ignore
                      </button>
                    )
                  )}

                  {r.status !== 'duplicate' && (
                    duplicateState?.id === r.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={duplicateState.duplicateOf}
                          onChange={(e) => setDuplicateState({ id: r.id, duplicateOf: e.target.value })}
                          placeholder="Original bug ID"
                          className="rounded bg-[#1a1a1a] border border-gray-700 text-gray-200 text-xs px-2 py-1 focus:outline-none focus:border-orange-500"
                        />
                        <button
                          onClick={() => patchReport(r.id, { status: 'duplicate', duplicateOf: duplicateState.duplicateOf })}
                          disabled={busy || !duplicateState.duplicateOf.trim()}
                          className="px-3 py-1.5 rounded-lg text-xs bg-yellow-900 hover:bg-yellow-800 text-yellow-300 transition-colors disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDuplicateState(null)}
                          className="text-xs text-gray-500 hover:text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDuplicateState({ id: r.id, duplicateOf: '' })}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-lg text-xs bg-[#1a1a1a] hover:bg-yellow-950 text-yellow-400 border border-gray-700 transition-colors disabled:opacity-50"
                      >
                        Mark Duplicate
                      </button>
                    )
                  )}

                  {r.status === 'new' && (
                    <button
                      onClick={() => patchReport(r.id, { status: 'reviewed' })}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg text-xs bg-[#1a1a1a] hover:bg-blue-950 text-blue-400 border border-gray-700 transition-colors disabled:opacity-50"
                    >
                      Mark Reviewed
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
