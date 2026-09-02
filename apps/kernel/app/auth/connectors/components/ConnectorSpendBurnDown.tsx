'use client';

/**
 * ConnectorSpendBurnDown — inference spend burn-down on a brain connector's
 * detail page (#1923, Phase 3 of #1922).
 *
 * Mirrors `ConnectorUsage.tsx`'s shape exactly (fetch-on-mount, render
 * nothing on error/loading) but reads `/connections/api/connectors/{id}/spend`
 * instead of the telemetry rollup: total spend against the connector's own
 * declared cap, plus the top session/turn/agent breakdowns by cost.
 */

import { useEffect, useState } from 'react';
import type { ConnectorEntry } from '@/src/lib/kernel/connector-registry';

interface BurnDownGroupRow {
  key: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  callCount: number;
}

interface InferenceBurnDown {
  spendCap: { amountUsd: number; period: string } | null;
  spentUsd: number;
  totalCostUsd: number;
  totalCallCount: number;
  bySession: BurnDownGroupRow[];
  byTurn: BurnDownGroupRow[];
  byAgent: BurnDownGroupRow[];
}

type BurnDownState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: InferenceBurnDown };

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

function BurnDownGroup({ title, rows, labelFor }: Readonly<{
  title: string;
  rows: BurnDownGroupRow[];
  labelFor: (key: string | null) => string;
}>) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">{title}</h4>
      <ul className="space-y-1">
        {rows.slice(0, 5).map((row) => (
          <li key={row.key ?? '(none)'} className="flex items-center justify-between gap-3 text-sm">
            <span className="font-mono text-xs text-gray-500 truncate">{labelFor(row.key)}</span>
            <span className="text-white shrink-0">{formatUsd(row.costUsd)} · {row.callCount} calls</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConnectorSpendBurnDown({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [state, setState] = useState<BurnDownState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    fetch(`/connections/api/connectors/${entry.id}/spend`)
      .then((r) => (r.ok ? (r.json() as Promise<InferenceBurnDown>) : Promise.reject(new Error(String(r.status)))))
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

  if (data.totalCallCount === 0) {
    return (
      <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-2">Spend burn-down</h3>
        <p className="text-sm text-gray-500">No metered inference calls yet for this connector.</p>
      </div>
    );
  }

  return (
    <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white mb-2">Spend burn-down</h3>
        <p className="text-sm text-gray-400">
          {formatUsd(data.totalCostUsd)} across {data.totalCallCount} {data.totalCallCount === 1 ? 'call' : 'calls'}
          {data.spendCap && (
            <> — {formatUsd(data.spentUsd)} of {formatUsd(data.spendCap.amountUsd)} {data.spendCap.period} cap</>
          )}
        </p>
      </div>
      <BurnDownGroup title="By session" rows={data.bySession} labelFor={(k) => k ?? '(no session id)'} />
      <BurnDownGroup title="By turn" rows={data.byTurn} labelFor={(k) => k ?? '(no turn id)'} />
      <BurnDownGroup title="By agent" rows={data.byAgent} labelFor={(k) => k ?? '(direct — no delegating app)'} />
    </div>
  );
}
