'use client';

import { useState } from 'react';
import type { HorizonStep } from '@/src/lib/loops/horizon';
import { browserSessionCommands, type SessionCommandClient } from './session-command-client';
import { useRunsHorizon } from './use-runs-horizon';

const zones = ['head', 'near', 'middle', 'tail', 'past'] as const;
const descriptions = {
  head: 'Claimed · sharp up close',
  near: 'Briefed + provisioned · ready to claim',
  middle: 'Issues + outcomes',
  tail: 'Intentions · fuzzy by design',
  past: 'Closed · awaiting exit conditions',
};

function leaseAge(acquiredAt: string): string {
  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(acquiredAt)) / 60_000);
  if (!Number.isFinite(minutes)) return 'age unknown';
  if (minutes < 1) return 'less than 1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function exitLabel(step: HorizonStep, id: string): string {
  const condition = step.conditions.find(item => item.declaration.id === id);
  switch (condition?.declaration.kind) {
    case 'issue_closed': return 'issue not closed';
    case 'release_contains': return 'not in a release';
    case 'deployed': return 'not on prod';
    case 'attestation': return `awaiting attestation · ${condition.declaration.attestorDid}`;
    default: return id;
  }
}

function PastConditions({ step }: Readonly<{ step: HorizonStep }>) {
  const release = step.conditions.find(item => item.satisfied && item.evidence
    && 'kind' in item.evidence.fact && item.evidence.fact.kind === 'release_contains');
  const fact = release?.evidence?.fact;
  return <div className="space-y-1 text-xs text-amber-200">
    {fact && 'tag' in fact && <p>In {fact.tag}</p>}
    <ul>{step.openExitConditions.map(id => <li key={id} className="break-words">{exitLabel(step, id)}</li>)}</ul>
  </div>;
}

function ClaimStep({ loopId, step, disabled, client }: Readonly<{
  loopId: string; step: HorizonStep; disabled: boolean; client: SessionCommandClient;
}>) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState('');
  const [error, setError] = useState('');
  async function claim() {
    setBusy(true);
    setError('');
    try {
      const command = await client.prepare(loopId, 'session.send', {
        loopId,
        message: `Claim horizon step ${JSON.stringify(step.stepId)} in loop ${JSON.stringify(loopId)}. Acquire its step lease through the signed loop rail; do not treat this request as an acquired lease.`,
      });
      const result = await client.dispatch(loopId, command);
      setReceipt(result.delivered
        ? 'Claim request delivered · awaiting projected lease'
        : 'Claim request recorded but undelivered · no lease confirmed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Claim request unavailable. No lease confirmed.');
    } finally { setBusy(false); }
  }
  return <div className="mt-2 space-y-1">
    <button type="button" disabled={disabled || busy || !!receipt}
      onClick={() => void claim()} className="min-h-11 border border-indigo-500 px-3 font-mono text-xs text-indigo-200 disabled:opacity-50"
      aria-label={`Sign & claim ${step.stepId}`}>{busy ? 'Signing claim…' : 'Sign & claim'}</button>
    {disabled && <p className="text-xs text-gray-400">Claim unavailable · a fresh projection and verified serving agent are required.</p>}
    {receipt && <output className="block text-xs text-indigo-200">{receipt}</output>}
    {error && <p role="alert" className="break-words text-xs text-red-300">{error}</p>}
  </div>;
}

export function RunsHorizon({ loopIds, onDenied, onSelect, client = browserSessionCommands, hasMore = false }: Readonly<{
  loopIds: string[]; onDenied: () => void; onSelect: (loopId: string) => void;
  client?: SessionCommandClient; hasMore?: boolean;
}>) {
  const { runs, error, loading } = useRunsHorizon(loopIds, onDenied);
  const items = runs.flatMap(run => run.horizon.steps.map(step => ({ ...run, step })))
    .filter(item => zones.some(zone => zone === item.step.zone))
    .sort((a, b) => a.step.rank - b.step.rank || a.loopId.localeCompare(b.loopId) || a.step.stepId.localeCompare(b.step.stepId));
  const depth = runs.reduce((total, run) => total + run.horizon.depth, 0);
  return <section aria-label="Runs horizon" className="mb-5 min-w-0 space-y-3" data-testid="runs-horizon">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-mono text-sm font-semibold text-gray-100">Horizon</h3>
      <output aria-label="Horizon depth" className="font-mono text-sm text-indigo-200">{depth} / 12</output>
    </div>
    <p className="text-xs text-gray-400">Nearest first · signed registry observation · updates every 5s</p>
    {loading && <p role="status" className="text-xs text-gray-400">Loading horizon…</p>}
    {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
    {!loading && !error && depth < 12 && <p className="text-xs text-amber-200">Below target · {12 - depth} more steps to reach 12. The horizon is not full yet.</p>}
    {hasMore && <p className="text-xs text-gray-400">Loaded runs only · load more runs below to include older horizons.</p>}
    {zones.map(zone => <section key={zone} aria-label={`${zone} steps`} className="min-w-0 border-l-2 border-indigo-500 pl-3">
      <h4 className="font-mono text-xs uppercase text-gray-200">{zone} <span className="text-gray-400">· {items.filter(item => item.step.zone === zone).length}</span></h4>
      <p className="mb-2 text-xs text-gray-400">{descriptions[zone]}</p>
      <ul className="space-y-2">{items.filter(item => item.step.zone === zone).map(({ loopId, step, commandAvailable }) =>
        <li key={`${loopId}:${step.stepId}`} className="min-w-0 space-y-1 border border-gray-800 bg-surface-card p-3" data-testid="horizon-step">
          <p className="break-words text-sm text-gray-100">{zone === 'tail' ? step.intention : step.issue?.ref ?? step.intention}</p>
          {zone !== 'tail' && step.issue?.outcome && <p className="break-words text-xs text-gray-300">{step.issue.outcome}</p>}
          {zone === 'head' && step.claim && <div className="text-xs text-gray-300">
            <p className="break-all">Holder · {step.claim.holderDid}</p>
            <p>Lease age · <time dateTime={step.claim.acquiredAt}>{leaseAge(step.claim.acquiredAt)}</time></p>
            <p className="break-words">Expires · <time dateTime={step.claim.expiresAt}>{step.claim.expiresAt}</time></p>
          </div>}
          {zone === 'past' && <PastConditions step={step} />}
          <a href={`#run-${encodeURIComponent(loopId)}`} onClick={() => onSelect(loopId)}
            className="inline-flex min-h-11 max-w-full items-center break-all font-mono text-xs text-indigo-300">Live loop · {loopId}</a>
          {zone === 'near' && <ClaimStep loopId={loopId} step={step} disabled={!!error || loading || !commandAvailable} client={client} />}
        </li>)}</ul>
    </section>)}
  </section>;
}
