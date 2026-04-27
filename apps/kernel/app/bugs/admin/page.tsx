'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useToast } from '@imajin/ui';
import type { BugReport } from '@/src/db';

const STATUSES = ['all', 'new', 'reviewed', 'imported', 'resolved', 'ignored', 'duplicate'] as const;
type StatusFilter = typeof STATUSES[number];

const STATUS_STYLES: Record<string, string> = {
  new: 'bg-surface-elevated text-primary',
  reviewed: 'bg-blue-900 text-blue-300',
  imported: 'bg-success text-success',
  resolved: 'bg-emerald-900 text-emerald-300',
  ignored: 'bg-error text-error',
  duplicate: 'bg-warning/20 text-warning',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5  text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-surface-elevated text-primary'}`}>
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
  const { toast } = useToast();
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
      toast.error(err instanceof Error ? err.message : 'Import failed');
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
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setActionLoading(null);
      setIgnoreState(null);
      setDuplicateState(null);
    }
  };

  return (
    <main className="min-h-screen px-6 py-12 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-primary mb-1 font-mono">Bug Reports — Admin</h1>
        <Link href="/bugs" className="text-sm text-imajin-orange hover:text-imajin-orange/70 transition-colors">
          ← My reports
        </Link>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === s
                ? 'bg-imajin-orange text-primary'
                : 'bg-[#1a1a1a] text-secondary hover:text-primary border border-white/10'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {error && (
        <div className="border border-red-900 bg-red-950/40 px-5 py-4 text-sm text-error mb-6">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-secondary text-sm">Loading...</p>
      ) : reports.length === 0 ? (
        <div className="border border-white/10 bg-[#111] px-6 py-12 text-center">
          <p className="text-secondary">No reports{filter !== 'all' ? ` with status "${filter}"` : ''}.</p>
        </div>
      ) : (
        <ul className="space-y-5">
          {reports.map((r) => {
            const busy = actionLoading === r.id;
            return (
              <li key={r.id} className="border border-white/10 bg-[#111] p-5">
                {/* Header */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <StatusBadge status={r.status} />
                  <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-surface-elevated text-primary">
                    {r.type === 'suggestion' ? '💡 Suggestion' : r.type === 'question' ? '❓ Question' : r.type === 'other' ? '💬 Other' : '🐛 Bug'}
                  </span>
                  <span className="text-xs text-secondary">{r.id}</span>
                  <span className="text-xs text-muted">{formatDate(r.createdAt)}</span>
                </div>

                {/* Reporter info */}
                <div className="text-xs text-secondary mb-2 space-y-0.5">
                  {r.reporterName && <p><span className="text-secondary">Name:</span> {r.reporterName}</p>}
                  <p><span className="text-secondary">DID:</span> <span className="font-mono">{r.reporterDid}</span></p>
                  {r.pageUrl && <p><span className="text-secondary">Page:</span> {r.pageUrl}</p>}
                  {r.viewport && <p><span className="text-secondary">Viewport:</span> {r.viewport}</p>}
                  {r.userAgent && <p className="truncate"><span className="text-secondary">UA:</span> {r.userAgent}</p>}
                </div>

                {/* Description */}
                <p className="text-sm text-primary whitespace-pre-wrap mb-3">{r.description}</p>

                {/* Screenshot */}
                {r.screenshotUrl && (
                  <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="inline-block mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.screenshotUrl}
                      alt="Screenshot"
                      className="max-h-40 border border-white/10 object-contain"
                    />
                  </a>
                )}

                {/* GitHub link */}
                {r.githubIssueUrl && (
                  <p className="text-xs mb-3">
                    <a href={r.githubIssueUrl} target="_blank" rel="noreferrer" className="text-imajin-orange hover:text-imajin-orange/70">
                      GitHub #{r.githubIssueNumber} →
                    </a>
                  </p>
                )}

                {/* Admin notes */}
                {r.adminNotes && (
                  <p className="text-xs text-secondary mb-3 italic">Notes: {r.adminNotes}</p>
                )}

                {/* Duplicate of */}
                {r.duplicateOf && (
                  <p className="text-xs text-warning mb-3">Duplicate of: {r.duplicateOf}</p>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-white/10">
                  {r.status !== 'imported' && (
                    <button
                      onClick={() => importToGitHub(r.id)}
                      disabled={busy}
                      className="px-3 py-1.5 text-xs bg-success hover:bg-success text-success transition-colors disabled:opacity-50"
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
                          className=" bg-[#1a1a1a] border border-white/10 text-primary text-xs px-2 py-1 focus:outline-none focus:border-imajin-orange"
                        />
                        <button
                          onClick={() => patchReport(r.id, { status: 'ignored', adminNotes: ignoreState.notes })}
                          disabled={busy}
                          className="px-3 py-1.5 text-xs bg-error hover:bg-error text-error transition-colors disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setIgnoreState(null)}
                          className="text-xs text-secondary hover:text-primary"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setIgnoreState({ id: r.id, notes: '' })}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs bg-[#1a1a1a] hover:bg-red-950 text-error border border-white/10 transition-colors disabled:opacity-50"
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
                          className=" bg-[#1a1a1a] border border-white/10 text-primary text-xs px-2 py-1 focus:outline-none focus:border-imajin-orange"
                        />
                        <button
                          onClick={() => patchReport(r.id, { status: 'duplicate', duplicateOf: duplicateState.duplicateOf })}
                          disabled={busy || !duplicateState.duplicateOf.trim()}
                          className="px-3 py-1.5 text-xs bg-warning/20 hover:bg-warning/30 text-warning transition-colors disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDuplicateState(null)}
                          className="text-xs text-secondary hover:text-primary"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDuplicateState({ id: r.id, duplicateOf: '' })}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs bg-[#1a1a1a] hover:bg-warning/30 text-warning border border-white/10 transition-colors disabled:opacity-50"
                      >
                        Mark Duplicate
                      </button>
                    )
                  )}

                  {r.status === 'new' && (
                    <button
                      onClick={() => patchReport(r.id, { status: 'reviewed' })}
                      disabled={busy}
                      className="px-3 py-1.5 text-xs bg-[#1a1a1a] hover:bg-blue-950 text-blue-400 border border-white/10 transition-colors disabled:opacity-50"
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
