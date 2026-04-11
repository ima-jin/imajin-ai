'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface SystemEvent {
  id: string;
  service: string;
  action: string;
  did: string | null;
  correlation_id: string | null;
  parent_event_id: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  duration_ms: number | null;
  created_at: string;
}

interface StatsData {
  total: number;
  byService: { service: string; count: number }[];
  byAction: { service: string; action: string; count: number }[];
}

interface Filters {
  service: string;
  action: string;
  did: string;
  correlationId: string;
  from: string;
  to: string;
}

const SERVICE_COLORS: Record<string, string> = {
  auth: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
  kernel: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  pay: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  events: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  connections: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400',
  chat: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400',
  profile: 'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-400',
  registry: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400',
  market: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-400',
  notify: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-400',
};

function serviceBadgeClass(service: string): string {
  return SERVICE_COLORS[service] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400';
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 inline-block" />
        ok
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400 inline-block" />
      {status}
    </span>
  );
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

export default function EventsClient() {
  const [filters, setFilters] = useState<Filters>({
    service: '',
    action: '',
    did: '',
    correlationId: '',
    from: '',
    to: '',
  });
  const [pendingFilters, setPendingFilters] = useState<Filters>({ ...filters });
  const [rows, setRows] = useState<SystemEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const LIMIT = 50;

  const fetchEvents = useCallback(
    async (f: Filters, off: number) => {
      setLoading(true);
      try {
        const p = new URLSearchParams();
        if (f.service) p.set('service', f.service);
        if (f.action) p.set('action', f.action);
        if (f.did) p.set('did', f.did);
        if (f.correlationId) p.set('correlationId', f.correlationId);
        if (f.from) p.set('from', f.from);
        if (f.to) p.set('to', f.to);
        p.set('limit', String(LIMIT));
        p.set('offset', String(off));
        const res = await fetch(`/api/admin/events?${p}`);
        if (res.ok) {
          const data = await res.json();
          setRows(data.rows);
          setTotal(data.total);
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const fetchStats = useCallback(async () => {
    const res = await fetch('/api/admin/events/stats');
    if (res.ok) {
      const data = await res.json();
      setStats(data);
    }
  }, []);

  useEffect(() => {
    fetchEvents(filters, offset);
    fetchStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters() {
    setFilters(pendingFilters);
    setOffset(0);
    setExpandedRows(new Set());
    fetchEvents(pendingFilters, 0);
    fetchStats();
  }

  function clearFilters() {
    const empty: Filters = { service: '', action: '', did: '', correlationId: '', from: '', to: '' };
    setPendingFilters(empty);
    setFilters(empty);
    setOffset(0);
    setExpandedRows(new Set());
    fetchEvents(empty, 0);
    fetchStats();
  }

  function refresh() {
    fetchEvents(filters, offset);
    fetchStats();
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
    fetchEvents(filters, newOffset);
  }

  function nextPage() {
    const newOffset = offset + LIMIT;
    setOffset(newOffset);
    fetchEvents(filters, newOffset);
  }

  const hasFilters = Object.values(pendingFilters).some(Boolean);
  const hasActiveFilters = Object.values(filters).some(Boolean);
  const hasPrev = offset > 0;
  const hasNext = offset + LIMIT < total;
  const page = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Events</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            System event stream — last 24h: {stats?.total.toLocaleString() ?? '…'} events
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1.5"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Stats summary */}
      {stats && stats.byService.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {stats.byService.map((s) => (
            <button
              key={s.service}
              onClick={() => {
                const f = { ...pendingFilters, service: s.service };
                setPendingFilters(f);
                setFilters(f);
                setOffset(0);
                fetchEvents(f, 0);
              }}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${serviceBadgeClass(s.service)} hover:opacity-80 transition-opacity cursor-pointer`}
            >
              {s.service}
              <span className="opacity-70">{s.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">Service</label>
          <select
            value={pendingFilters.service}
            onChange={(e) => setPendingFilters({ ...pendingFilters, service: e.target.value })}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="">All services</option>
            {(stats?.byService ?? []).map((s) => (
              <option key={s.service} value={s.service}>{s.service}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">Action</label>
          <input
            type="text"
            value={pendingFilters.action}
            onChange={(e) => setPendingFilters({ ...pendingFilters, action: e.target.value })}
            placeholder="e.g. ticket.purchase"
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 w-44"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">DID</label>
          <input
            type="text"
            value={pendingFilters.did}
            onChange={(e) => setPendingFilters({ ...pendingFilters, did: e.target.value })}
            placeholder="did:key:…"
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 w-48"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">From</label>
          <input
            type="datetime-local"
            value={pendingFilters.from}
            onChange={(e) => setPendingFilters({ ...pendingFilters, from: e.target.value })}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">To</label>
          <input
            type="datetime-local"
            value={pendingFilters.to}
            onChange={(e) => setPendingFilters({ ...pendingFilters, to: e.target.value })}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <button
          onClick={applyFilters}
          className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium self-end"
        >
          Filter
        </button>
        {hasFilters || hasActiveFilters ? (
          <button
            onClick={clearFilters}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 self-end py-1.5"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Total count */}
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {loading ? 'Loading…' : `${total.toLocaleString()} events`}
      </p>

      {/* Table */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
        {!loading && rows.length === 0 ? (
          <p className="px-6 py-10 text-sm text-gray-400 dark:text-gray-500 text-center">
            No events found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Time</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Service</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Action</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">DID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">ms</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {rows.map((row) => {
                  const isExpanded = expandedRows.has(row.id);
                  const hasPayload = row.payload && Object.keys(row.payload).length > 0;
                  return (
                    <>
                      <tr
                        key={row.id}
                        onClick={() => hasPayload && toggleRow(row.id)}
                        className={`hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors ${hasPayload ? 'cursor-pointer' : ''} ${row.status !== 'success' ? 'bg-red-50/40 dark:bg-red-900/10' : ''}`}
                      >
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap font-mono">
                          {formatTs(row.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${serviceBadgeClass(row.service)}`}>
                            {row.service}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-gray-700 dark:text-gray-300">
                          {row.action}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-gray-500 dark:text-gray-400">
                          <span title={row.did ?? undefined}>{truncateDid(row.did)}</span>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                          {row.duration_ms != null ? `${row.duration_ms}` : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {row.correlation_id ? (
                            <Link
                              href={`/admin/events/trace/${encodeURIComponent(row.correlation_id)}`}
                              className="text-xs font-mono text-orange-600 dark:text-orange-400 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                              title={row.correlation_id}
                            >
                              {row.correlation_id.slice(0, 12)}…
                            </Link>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasPayload && (
                        <tr key={`${row.id}-payload`} className="bg-gray-50 dark:bg-gray-900/40">
                          <td colSpan={7} className="px-6 py-3">
                            <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
                              {JSON.stringify(row.payload, null, 2)}
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
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← Previous
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">Page {page}</span>
        <button
          onClick={nextPage}
          disabled={!hasNext}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
