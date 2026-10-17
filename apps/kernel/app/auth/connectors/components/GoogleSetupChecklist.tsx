'use client';

import { useEffect, useState } from 'react';
import {
  GOOGLE_SETUP_STEPS, GOOGLE_SETUP_STATUSES,
  type GoogleSetupStatus, type GoogleSetupStepId, type GoogleSetupView,
} from '@/src/lib/google/setup-content';
import type { GoogleSetupCheck } from '@/src/lib/google/setup-checks';
import { slotRoute } from './ConnectionSlots';

const inputClass = 'w-full min-w-0 rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-sm text-white';
const buttonClass = 'rounded-lg border border-white/20 px-3 py-2 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-50';

interface SetupResponse extends GoogleSetupView {
  checks?: { searchConsole: GoogleSetupCheck };
}

async function readResponse(response: Response): Promise<SetupResponse> {
  const data = await response.json() as SetupResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Could not update Google setup.');
  if (!data.steps || !GOOGLE_SETUP_STEPS.every(({ id }) => data.steps[id])) {
    throw new Error('Google setup status is unavailable. Reload setup to retry.');
  }
  return data;
}

export function GoogleSetupChecklist({ slot, revision, onChange }: Readonly<{
  slot: string;
  revision: string;
  onChange: (view: GoogleSetupView | null) => void;
}>) {
  const [view, setView] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caseUrl, setCaseUrl] = useState('');
  const endpoint = slotRoute('/google/api/setup', slot);

  useEffect(() => {
    let cancelled = false;
    void fetch(endpoint, { cache: 'no-store' }).then(readResponse).then((data) => {
      if (cancelled) return;
      setView(data); setCaseUrl(data.steps['business-access'].caseUrl ?? '');
      setError(null); onChange(data);
    }).catch(() => {
      if (!cancelled) { setError('Could not load Google setup. Retry below.'); onChange(null); }
    });
    return () => { cancelled = true; };
  }, [endpoint, revision, onChange]);

  async function request(method: 'PATCH' | 'POST' | 'GET', body?: Record<string, string>) {
    setBusy(true); setError(null);
    try {
      const data = await readResponse(await fetch(endpoint, {
        method, cache: 'no-store',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      }));
      setView(data); onChange(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update Google setup.');
    } finally { setBusy(false); }
  }

  function update(step: GoogleSetupStepId, status: GoogleSetupStatus) {
    void request('PATCH', { step, status });
  }

  return (
    <section aria-label="Google guided admin setup" className="space-y-4 rounded-xl border border-white/10 p-4">
      <h3 className="font-semibold text-white">Google guided admin setup</h3>
      <p className="text-sm text-gray-300">Setup is saved for this identity and connection slot ({slot}). Search Console does not wait for Business Profile approval. Statuses are admin-reported, not Google approval checks.</p>
      {!view && !error && <p className="text-sm text-gray-300">Loading setup…</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <ol className="space-y-5">
        {GOOGLE_SETUP_STEPS.map((step, index) => {
          const state = view?.steps[step.id];
          return (
            <li key={step.id} className="min-w-0 space-y-2 border-t border-white/10 pt-3">
              <h4 className="font-medium text-white">{index + 1}. {step.title}</h4>
              <p className="text-sm text-gray-300">{step.instructions}</p>
              <ul className="flex flex-wrap gap-x-4 gap-y-2">
                {step.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} target={link.href.startsWith('https:') ? '_blank' : undefined}
                      rel={link.href.startsWith('https:') ? 'noopener noreferrer' : undefined}
                      className="text-sm text-amber-300 underline">{link.label}</a>
                  </li>
                ))}
              </ul>
              <label className="block text-sm text-gray-300">
                <span className="block mb-1">{step.title} status</span>
                <select aria-label={`${step.title} status`} className={inputClass}
                  value={state?.status ?? 'not_started'} disabled={!view || busy}
                  onChange={(event) => update(step.id, event.target.value as GoogleSetupStatus)}>
                  {Object.entries(GOOGLE_SETUP_STATUSES).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              {state?.status === 'pending_google' && (
                <p className="text-sm text-amber-300">
                  Pending Google approval for {step.title}
                  {state.pendingSince && <> since <time dateTime={state.pendingSince}>{new Date(state.pendingSince).toLocaleString()}</time></>}.
                </p>
              )}
              {(state?.status === 'pending_google' || state?.status === 'failed') && (
                <p className="text-sm text-gray-300">{step.recovery}</p>
              )}
              {step.id === 'business-access' && (
                <form onSubmit={(event) => {
                  event.preventDefault();
                  if (state) void request('PATCH', { step: step.id, status: state.status, caseUrl: caseUrl.trim() });
                }} className="space-y-2">
                  <label className="block text-sm text-gray-300">
                    <span className="block mb-1">Google Business Profile support case URL (non-secret)</span>
                    <input aria-label="Google Business Profile support case URL" type="url" className={inputClass}
                      value={caseUrl} onChange={(event) => setCaseUrl(event.target.value)}
                      placeholder="https://support.google.com/..." maxLength={2048} required disabled={busy || !view} />
                  </label>
                  <button type="submit" className={buttonClass} disabled={busy || !view || !caseUrl.trim()}>Save case link</button>
                  {state?.caseUrl && <a href={state.caseUrl} target="_blank" rel="noopener noreferrer" className="ml-3 text-sm text-amber-300 underline">Open saved Google case</a>}
                </form>
              )}
            </li>
          );
        })}
      </ol>
      {view && (
        <div className="space-y-2 text-sm text-gray-300" aria-live="polite">
          <p>Identity vault OAuth client: {view.configSealed ? 'sealed and ready' : 'not ready'}. Google connection: {view.tokenSealed ? 'sealed' : 'not connected'}.</p>
          {view.credentialPending && <p>Vault delegation approval is pending. This is separate from Google approval.</p>}
          <p>Business Profile: {view.businessProfileAvailable ? 'available for scope selection' : 'disabled — requires project approval and installation operator enablement'}.</p>
          {view.checks && <p>{view.checks.searchConsole.message}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => { void request('GET'); }}>Reload setup</button>
        <button type="button" className={buttonClass} disabled={busy || !view} onClick={() => { void request('POST'); }}>
          {busy ? 'Working…' : 'Check connection'}
        </button>
      </div>
    </section>
  );
}
