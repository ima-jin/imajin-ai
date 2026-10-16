'use client';

import { useEffect, useState } from 'react';
import { SCOPE_VOCABULARY, isKnownScope } from '@imajin/auth/scope-vocabulary';
import { approvalCardAnchorId, requestApprovalsRefresh } from './approval-anchor';

interface ScopeState {
  requestedScopes: string[];
  approvedServiceScopes: string[];
}

const EMPTY_SCOPES: ScopeState = { requestedScopes: [], approvedServiceScopes: [] };
const SERVICE_SCOPES_URL = '/api/apps/service-scopes';

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

async function readScopes(appDid: string): Promise<ScopeState> {
  try {
    const res = await fetch(`${SERVICE_SCOPES_URL}?appDid=${encodeURIComponent(appDid)}`, { credentials: 'include' });
    if (!res.ok) return EMPTY_SCOPES;
    const body = await res.json() as Partial<ScopeState>;
    return {
      requestedScopes: stringList(body.requestedScopes),
      approvedServiceScopes: stringList(body.approvedServiceScopes),
    };
  } catch {
    return EMPTY_SCOPES;
  }
}

async function proposeScopes(appDid: string, scopes: string[]): Promise<{ proposalId?: string; message?: string; error?: string }> {
  try {
    const res = await fetch(SERVICE_SCOPES_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appDid, scopes, action: 'grant' }),
    });
    const body = await res.json().catch(() => ({})) as { status?: string; proposalId?: string; error?: string };
    if (!res.ok) return { error: body.error ?? `Failed to propose service scopes (${res.status})` };
    if (body.status === 'pending' && body.proposalId) return { proposalId: body.proposalId };
    if (body.status === 'already-approved') return { message: 'These service scopes are already approved.' };
    return { error: 'Unexpected response from apps.service-scopes' };
  } catch {
    return { error: 'Network error — service scopes were not proposed' };
  }
}

export function ProvisionedAppScopes({ appDid }: Readonly<{ appDid: string }>) {
  const [scopes, setScopes] = useState<ScopeState>(EMPTY_SCOPES);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof proposeScopes>>>({});

  useEffect(() => {
    let cancelled = false;
    void readScopes(appDid).then((state) => {
      if (cancelled) return;
      setScopes(state);
      setSelected(state.requestedScopes.filter((scope) => isKnownScope(scope) && !state.approvedServiceScopes.includes(scope)));
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [appDid]);

  function toggle(scope: string) {
    setSelected((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  }

  async function submit() {
    setBusy(true);
    setResult({});
    const next = await proposeScopes(appDid, selected);
    setResult(next);
    setBusy(false);
    if (next.proposalId) {
      setOpen(false);
      requestApprovalsRefresh();
    }
  }

  return (
    <div className="w-full space-y-2 border-t border-gray-800 pt-2 pb-3">
      <p className="text-gray-400">Requested scopes: <span className="font-mono text-gray-200">{scopes.requestedScopes.join(', ') || 'None'}</span></p>
      <p className="text-gray-400">Approved service scopes: <span className="font-mono text-green-300">{scopes.approvedServiceScopes.join(', ') || 'None'}</span></p>
      <button type="button" disabled={!loaded || busy} aria-expanded={open} onClick={() => setOpen(!open)}
        className="rounded bg-gray-800 px-2.5 py-1 text-gray-200 hover:bg-gray-700 disabled:opacity-40">
        Propose scopes
      </button>
      {open && (
        <div className="space-y-2">
          <p className="text-gray-400">Requested, unapproved scopes are preselected. Grants require your countersignature in Operator approvals below.</p>
          <fieldset disabled={busy} className="max-h-60 overflow-y-auto space-y-1">
            <legend className="text-gray-300">Service scopes to propose</legend>
            {SCOPE_VOCABULARY.map(({ scope, label }) => (
              <label key={scope} className="flex items-start gap-2 text-gray-300">
                <input type="checkbox" checked={selected.includes(scope)}
                  disabled={scopes.approvedServiceScopes.includes(scope)} onChange={() => toggle(scope)} />
                <span><span className="font-mono">{scope}</span> — {label}
                  {scopes.requestedScopes.includes(scope) && ' (requested)'}
                  {scopes.approvedServiceScopes.includes(scope) && ' (approved)'}
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={busy || selected.length === 0} onClick={() => void submit()}
            className="rounded bg-amber-800/60 px-2.5 py-1 text-amber-100 disabled:opacity-40">
            {busy ? 'Proposing…' : 'Submit scope proposal'}
          </button>
        </div>
      )}
      {result.error && <p role="alert" className="text-red-400">{result.error}</p>}
      {result.message && <p role="status" className="text-gray-300">{result.message}</p>}
      {result.proposalId && (
        <p role="status" className="text-amber-300">
          Proposal pending in <a className="underline" href={`#${approvalCardAnchorId(result.proposalId)}`}>Operator approvals below</a>. Nothing is approved until you countersign there.
        </p>
      )}
    </div>
  );
}
