'use client';

/**
 * ConnectorUsage — minimal usage view on the connector detail page (#1799).
 *
 * Fetches the per-DID, per-connector-scope telemetry rollup and renders a
 * total signed-action count, the time range it spans, and a breakdown by
 * kind (attestation type / signed connector action). Session cookie carries
 * auth, same as every other fetch on this page — no extra wiring needed.
 *
 * Usage is supplementary to the connect/scope/disconnect flow this page
 * exists for, so a failed or still-loading fetch renders nothing rather than
 * blocking or cluttering the page with an error state.
 */

import { useEffect, useState } from 'react';
import type { ConnectorEntry } from '@/src/lib/kernel/connector-registry';

interface TelemetryKindCount {
  source: 'attestation' | 'github_action';
  kind: string;
  count: number;
}

interface TelemetryRollup {
  totalCount: number;
  byKind: TelemetryKindCount[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

type UsageState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: TelemetryRollup };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function ConnectorUsage({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [state, setState] = useState<UsageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    fetch(`/connections/api/connectors/${entry.id}/telemetry`)
      .then((r) => (r.ok ? (r.json() as Promise<TelemetryRollup>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  if (state.status !== 'ready') return null;

  const { data } = state;

  return (
    <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white mb-2">Usage</h3>
      {data.totalCount === 0 ? (
        <p className="text-sm text-gray-500">No signed activity yet for this connector.</p>
      ) : (
        <>
          <p className="text-sm text-gray-400 mb-3">
            {data.totalCount} signed {data.totalCount === 1 ? 'action' : 'actions'}
            {data.firstSeenAt && data.lastSeenAt && (
              <> between {formatDate(data.firstSeenAt)} and {formatDate(data.lastSeenAt)}</>
            )}
          </p>
          <ul className="space-y-1">
            {data.byKind.map((row) => (
              <li key={`${row.source}:${row.kind}`} className="flex items-center justify-between gap-3 text-sm">
                <span className="font-mono text-xs text-gray-500 truncate">{row.kind}</span>
                <span className="text-white shrink-0">{row.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
