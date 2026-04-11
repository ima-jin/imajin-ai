'use client';

import { useState } from 'react';
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

const SERVICE_COLORS: Record<string, string> = {
  auth: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400 border-purple-300 dark:border-purple-700',
  kernel: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-700',
  pay: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border-green-300 dark:border-green-700',
  events: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-700',
  connections: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 border-cyan-300 dark:border-cyan-700',
  chat: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 border-indigo-300 dark:border-indigo-700',
  profile: 'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-400 border-pink-300 dark:border-pink-700',
  registry: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400 border-yellow-300 dark:border-yellow-700',
  market: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-400 border-teal-300 dark:border-teal-700',
  notify: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-700',
};

function serviceBadgeClass(service: string) {
  return SERVICE_COLORS[service] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600';
}

function formatTs(ts: string) {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}

export default function TraceView({ events, correlationId }: { events: SystemEvent[]; correlationId: string }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalMs = (() => {
    if (events.length === 0) return null;
    const first = new Date(events[0].created_at).getTime();
    const last = new Date(events[events.length - 1].created_at).getTime();
    const lastDur = events[events.length - 1].duration_ms ?? 0;
    return last - first + lastDur;
  })();

  const hasFailure = events.some((e) => e.status !== 'success');

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Link
            href="/admin/events"
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            ← Events
          </Link>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Trace</h1>
        <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 break-all">
          {correlationId}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600 dark:text-gray-300">
            <span className="font-semibold">{events.length}</span> events
          </span>
          {totalMs != null && (
            <span className="text-gray-600 dark:text-gray-300">
              <span className="font-semibold">{totalMs}</span> ms total
            </span>
          )}
          {hasFailure && (
            <span className="text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 px-2 py-0.5 rounded font-medium">
              contains failures
            </span>
          )}
        </div>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 px-6 py-10 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">No events found for this correlation ID</p>
        </div>
      ) : (
        <div className="relative">
          {/* Vertical connector line */}
          <div className="absolute left-[1.4rem] top-6 bottom-6 w-px bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

          <div className="space-y-0">
            {events.map((evt, idx) => {
              const isExpanded = expandedIds.has(evt.id);
              const hasPayload = evt.payload && Object.keys(evt.payload).length > 0;
              const isFailed = evt.status !== 'success';
              const isLast = idx === events.length - 1;

              return (
                <div key={evt.id} className="relative pl-12">
                  {/* Node dot */}
                  <div
                    className={`absolute left-2.5 top-5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      isFailed
                        ? 'bg-red-100 dark:bg-red-900/60 border-red-400 dark:border-red-500'
                        : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
                    }`}
                  >
                    {isFailed ? (
                      <span className="text-red-500 dark:text-red-400 leading-none" style={{ fontSize: '8px' }}>✕</span>
                    ) : (
                      <span className="text-green-500 dark:text-green-400 leading-none" style={{ fontSize: '8px' }}>✓</span>
                    )}
                  </div>

                  <div
                    className={`mb-2 rounded-xl border ${
                      isFailed
                        ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10'
                        : 'border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800'
                    } shadow-sm`}
                  >
                    <div
                      className={`px-4 py-3 flex flex-wrap items-center gap-3 ${hasPayload ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded-xl' : ''} transition-colors`}
                      onClick={() => hasPayload && toggle(evt.id)}
                    >
                      {/* Step number */}
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-600 w-5 text-right shrink-0">
                        {idx + 1}
                      </span>

                      {/* Service badge */}
                      <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${serviceBadgeClass(evt.service)}`}>
                        {evt.service}
                      </span>

                      {/* Action */}
                      <span className="text-sm font-mono text-gray-800 dark:text-gray-200 flex-1 min-w-0">
                        {evt.action}
                      </span>

                      {/* Duration bar + ms */}
                      <div className="flex items-center gap-2 shrink-0">
                        {evt.duration_ms != null && (
                          <>
                            <div className="w-24 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${isFailed ? 'bg-red-400 dark:bg-red-500' : 'bg-orange-400 dark:bg-orange-500'}`}
                                style={{
                                  width: `${Math.min(100, (evt.duration_ms / Math.max(...events.map((e) => e.duration_ms ?? 0), 1)) * 100)}%`,
                                }}
                              />
                            </div>
                            <span className="text-xs text-gray-500 dark:text-gray-400 w-14 text-right font-mono">
                              {evt.duration_ms}ms
                            </span>
                          </>
                        )}
                      </div>

                      {/* Timestamp */}
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-600 shrink-0">
                        {formatTs(evt.created_at)}
                      </span>

                      {/* Expand chevron */}
                      {hasPayload && (
                        <span className="text-gray-400 dark:text-gray-600 text-xs shrink-0">
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      )}
                    </div>

                    {/* DID */}
                    {evt.did && (
                      <div className="px-4 pb-2 -mt-1">
                        <span className="text-xs font-mono text-gray-400 dark:text-gray-600">
                          {evt.did.length > 40 ? `${evt.did.slice(0, 20)}…${evt.did.slice(-10)}` : evt.did}
                        </span>
                      </div>
                    )}

                    {/* Expanded payload */}
                    {isExpanded && hasPayload && (
                      <div className="px-4 pb-3 border-t border-gray-100 dark:border-gray-700 mt-1 pt-2">
                        <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
                          {JSON.stringify(evt.payload, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
