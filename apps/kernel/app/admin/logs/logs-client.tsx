'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';

interface AppLog {
  id: string;
  service: string;
  level: string;
  message: string;
  correlation_id: string | null;
  did: string | null;
  method: string | null;
  path: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface Filters {
  service: string;
  levels: string[];
  correlationId: string;
  did: string;
  search: string;
  from: string;
  to: string;
}

const SERVICE_COLORS: Record<string, string> = {
  auth: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
  kernel: 'bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange',
  pay: 'bg-success/10 dark:bg-success/40 text-success dark:text-success',
  events: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  connections: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400',
  chat: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400',
  profile: 'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-400',
  registry: 'bg-yellow-100 dark:bg-warning/20/40 text-warning dark:text-warning',
  market: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-400',
  notify: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-400',
};

const LEVEL_COLORS: Record<string, string> = {
  debug: 'bg-gray-100 dark:bg-surface-elevated text-secondary',
  info: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  warn: 'bg-warning/10 dark:bg-warning/20 text-warning dark:text-warning',
  error: 'bg-error/10 dark:bg-error/40 text-error dark:text-error',
};

const ALL_LEVELS = ['debug', 'info', 'warn', 'error'];

function serviceBadgeClass(service: string): string {
  return SERVICE_COLORS[service] ?? 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary';
}

function formatTs(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + ' ' + d.toLocaleDateString();
}

function truncateDid(did: string | null) {
  if (!did) return '—';
  if (did.length <= 24) return did;
  return `${did.slice(0, 12)}…${did.slice(-8)}`;
}

const EMPTY_FILTERS: Filters = {
  service: '',
  levels: [],
  correlationId: '',
  did: '',
  search: '',
  from: '',
  to: '',
};

const LIMIT = 50;

export default function LogsClient() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [pendingFilters, setPendingFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<AppLog[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [cleanupDays, setCleanupDays] = useState(14);
  const [cleanupMsg, setCleanupMsg] = useState('');
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async (f: Filters, off: number) => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (f.service) p.set('service', f.service);
      if (f.levels.length > 0) p.set('level', f.levels.join(','));
      if (f.correlationId) p.set('correlationId', f.correlationId);
      if (f.did) p.set('did', f.did);
      if (f.search) p.set('search', f.search);
      if (f.from) p.set('from', f.from);
      if (f.to) p.set('to', f.to);
      p.set('limit', String(LIMIT));
      p.set('offset', String(off));
      const res = await fetch(`/api/admin/logs?${p}`);
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs(filters, offset);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      autoRefreshRef.current = setInterval(() => fetchLogs(filters, offset), 5000);
    } else {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, filters, offset]);

  function applyFilters() {
    setFilters(pendingFilters);
    setOffset(0);
    setExpandedRows(new Set());
    fetchLogs(pendingFilters, 0);
  }

  function clearFilters() {
    setPendingFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setOffset(0);
    setExpandedRows(new Set());
    fetchLogs(EMPTY_FILTERS, 0);
  }

  function refresh() {
    fetchLogs(filters, offset);
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function prevPage() {
    const newOffset = Math.max(0, offset - LIMIT);
    setOffset(newOffset);
    fetchLogs(filters, newOffset);
  }

  function nextPage() {
    const newOffset = offset + LIMIT;
    setOffset(newOffset);
    fetchLogs(filters, newOffset);
  }

  function toggleLevel(level: string) {
    const levels = pendingFilters.levels.includes(level)
      ? pendingFilters.levels.filter((l) => l !== level)
      : [...pendingFilters.levels, level];
    setPendingFilters({ ...pendingFilters, levels });
  }

  async function runCleanup() {
    setCleanupMsg('Running…');
    try {
      const res = await fetch(`/api/admin/logs/cleanup?days=${cleanupDays}`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setCleanupMsg(`Deleted ${data.deleted} rows`);
        fetchLogs(filters, offset);
      } else {
        setCleanupMsg('Error');
      }
    } catch {
      setCleanupMsg('Error');
    }
    setTimeout(() => setCleanupMsg(''), 4000);
  }

  const hasFilters = Object.entries(pendingFilters).some(([k, v]) =>
    k === 'levels' ? (v as string[]).length > 0 : Boolean(v)
  );
  const hasActiveFilters = Object.entries(filters).some(([k, v]) =>
    k === 'levels' ? (v as string[]).length > 0 : Boolean(v)
  );
  const hasPrev = offset > 0;
  const hasNext = offset + LIMIT < total;
  const page = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Application Logs</h1>
          <p className="mt-1 text-sm text-secondary dark:text-secondary">
            Structured log entries from @imajin/logger — persisted when ENABLE_APP_LOG=true
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`border px-3 py-1.5 text-sm flex items-center gap-1.5 ${
              autoRefresh
                ? 'border-imajin-orange text-imajin-orange dark:text-imajin-orange bg-imajin-orange/10 dark:bg-imajin-orange/20'
                : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated'
            }`}
          >
            {autoRefresh ? '⏸ Auto' : '▶ Auto'}
          </button>
          <button
            onClick={refresh}
            className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated flex items-center gap-1.5"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2 items-end">
        {/* Service */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">Service</label>
          <input
            type="text"
            value={pendingFilters.service}
            onChange={(e) => setPendingFilters({ ...pendingFilters, service: e.target.value })}
            placeholder="e.g. kernel"
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-36"
          />
        </div>

        {/* Level pills */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">Level</label>
          <div className="flex gap-1">
            {ALL_LEVELS.map((level) => {
              const active = pendingFilters.levels.includes(level);
              return (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  className={`text-xs px-2 py-1  font-medium transition-opacity ${
                    active
                      ? LEVEL_COLORS[level]
                      : 'bg-gray-100 dark:bg-surface-elevated text-secondary opacity-50 hover:opacity-75'
                  }`}
                >
                  {level}
                </button>
              );
            })}
          </div>
        </div>

        {/* Search */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">Search</label>
          <input
            type="text"
            value={pendingFilters.search}
            onChange={(e) => setPendingFilters({ ...pendingFilters, search: e.target.value })}
            placeholder="message contains…"
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-44"
          />
        </div>

        {/* Correlation ID */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">Correlation ID</label>
          <input
            type="text"
            value={pendingFilters.correlationId}
            onChange={(e) => setPendingFilters({ ...pendingFilters, correlationId: e.target.value })}
            placeholder="cor_…"
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-44"
          />
        </div>

        {/* DID */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">DID</label>
          <input
            type="text"
            value={pendingFilters.did}
            onChange={(e) => setPendingFilters({ ...pendingFilters, did: e.target.value })}
            placeholder="did:key:…"
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-44"
          />
        </div>

        {/* From / To */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">From</label>
          <input
            type="datetime-local"
            value={pendingFilters.from}
            onChange={(e) => setPendingFilters({ ...pendingFilters, from: e.target.value })}
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-secondary dark:text-secondary">To</label>
          <input
            type="datetime-local"
            value={pendingFilters.to}
            onChange={(e) => setPendingFilters({ ...pendingFilters, to: e.target.value })}
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
          />
        </div>

        <button
          onClick={applyFilters}
          style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-3 py-1.5 text-sm font-medium self-end"
        >
          Filter
        </button>
        {(hasFilters || hasActiveFilters) && (
          <button
            onClick={clearFilters}
            className="text-sm text-secondary dark:text-secondary hover:text-gray-700 dark:hover:text-primary self-end py-1.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Total count */}
      <p className="mb-2 text-xs text-secondary dark:text-secondary">
        {loading ? 'Loading…' : `${total.toLocaleString()} logs`}
      </p>

      {/* Table */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
        {!loading && rows.length === 0 ? (
          <p className="px-6 py-10 text-sm text-secondary dark:text-secondary text-center">
            No logs found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Time</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Service</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Level</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Message</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">DID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {rows.map((row) => {
                  const isExpanded = expandedRows.has(row.id);
                  const hasMetadata = row.metadata && Object.keys(row.metadata).length > 0;
                  const isError = row.level === 'error';
                  const isWarn = row.level === 'warn';
                  return (
                    <>
                      <tr
                        key={row.id}
                        onClick={() => hasMetadata && toggleRow(row.id)}
                        className={`hover:bg-gray-50 dark:hover:bg-surface-elevated/40 transition-colors ${hasMetadata ? 'cursor-pointer' : ''} ${isError ? 'bg-error/10/40 dark:bg-error/10' : isWarn ? 'bg-warning/10 dark:bg-warning/10' : ''}`}
                      >
                        <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap font-mono">
                          {formatTs(row.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5  font-medium ${serviceBadgeClass(row.service)}`}>
                            {row.service}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5  font-medium ${LEVEL_COLORS[row.level] ?? 'bg-gray-100 text-secondary'}`}>
                            {row.level}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-700 dark:text-primary max-w-xs">
                          <span className="truncate block" title={row.message}>{row.message}</span>
                          {row.path && (
                            <span className="text-secondary font-mono">{row.method} {row.path}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-secondary dark:text-secondary">
                          <span title={row.did ?? undefined}>{truncateDid(row.did)}</span>
                        </td>
                        <td className="px-4 py-3">
                          {row.correlation_id ? (
                            <Link
                              href={`/admin/telemetry/trace/${encodeURIComponent(row.correlation_id)}`}
                              className="text-xs font-mono text-imajin-orange dark:text-imajin-orange hover:underline"
                              onClick={(e) => e.stopPropagation()}
                              title={row.correlation_id}
                            >
                              {row.correlation_id.slice(0, 12)}…
                            </Link>
                          ) : (
                            <span className="text-xs text-secondary">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasMetadata && (
                        <tr key={`${row.id}-meta`} className="bg-gray-50 dark:bg-surface-surface/40">
                          <td colSpan={6} className="px-6 py-3">
                            <pre className="text-xs font-mono text-gray-700 dark:text-primary whitespace-pre-wrap break-all">
                              {JSON.stringify(row.metadata, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={prevPage}
          disabled={!hasPrev}
          className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← Previous
        </button>
        <span className="text-sm text-secondary dark:text-secondary">
          Page {page} — Showing {Math.min(offset + 1, total)}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}
        </span>
        <button
          onClick={nextPage}
          disabled={!hasNext}
          className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </div>

      {/* Cleanup section */}
      <div className="mt-8 pt-6 border-t border-gray-100 dark:border-white/10">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-primary mb-3 font-mono">Log Retention Cleanup</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-secondary dark:text-secondary">Delete logs older than</span>
          <input
            type="number"
            min={1}
            value={cleanupDays}
            onChange={(e) => setCleanupDays(Math.max(1, parseInt(e.target.value, 10) || 14))}
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple w-20"
          />
          <span className="text-sm text-secondary dark:text-secondary">days</span>
          <button
            onClick={runCleanup}
            className="bg-error hover:bg-error text-primary px-3 py-1.5 text-sm font-medium"
          >
            Run cleanup
          </button>
          {cleanupMsg && (
            <span className="text-sm text-muted dark:text-secondary">{cleanupMsg}</span>
          )}
        </div>
      </div>
    </div>
  );
}
