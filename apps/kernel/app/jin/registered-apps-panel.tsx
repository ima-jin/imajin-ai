'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppProvenancePoint, RegisteredApp } from '@/src/lib/apps/registered-apps';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTimestamp(value: unknown): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}
function isPoint(value: unknown): boolean {
  return isRecord(value) && isTimestamp(value.at) && (value.by === null || typeof value.by === 'string');
}
function isApp(value: unknown): value is RegisteredApp {
  if (!isRecord(value)) return false;
  return ['id', 'appDid', 'name'].every(key => typeof value[key] === 'string')
    && ['MCP/DCR client', 'delegated app', 'first-party seed'].includes(String(value.kind))
    && ['active', 'dormant', 'expired', 'revoked'].includes(String(value.status))
    && ['created', 'firstConsent', 'ended'].every(key => isPoint(value[key]))
    && Number.isInteger(value.consentingPrincipals) && Number(value.consentingPrincipals) >= 0
    && Number.isInteger(value.liveConsents) && Number(value.liveConsents) >= 0
    && (value.revocationId === null || typeof value.revocationId === 'string')
    && isTimestamp(value.lastSeen);
}
async function readRegisteredApps(signal: AbortSignal): Promise<RegisteredApp[] | null> {
  const response = await fetch('/jin/api/registered-apps', { credentials: 'include', cache: 'no-store', signal });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('Unavailable');
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.apps) || !body.apps.every(isApp)) throw new Error('Invalid metadata');
  return body.apps;
}

function Time({ at, fallback = 'unknown (not recorded)' }: Readonly<{ at: string | null; fallback?: string }>) {
  return at ? <time dateTime={at}>{at}</time> : <>{fallback}</>;
}
function Provenance({ label, point, fallback }: Readonly<{
  label: string; point: AppProvenancePoint; fallback?: string;
}>) {
  return <div><dt className="inline text-gray-300">{label}</dt><dd className="inline">
    {' · '}<Time at={point.at} fallback={fallback} />{' · '}
    <span className="font-mono">{point.by ?? 'unknown (not recorded)'}</span>
  </dd></div>;
}
function ClearApp({ app, onCleared }: Readonly<{ app: RegisteredApp; onCleared: () => void }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const clear = async () => {
    if (request.current) return;
    if (!globalThis.confirm(`Clear ${app.name}? This will end ${app.liveConsents} live consent${app.liveConsents === 1 ? '' : 's'}. The app and its history will be kept.`)) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(false);
    try {
      const response = await fetch(`/api/admin/registry/apps/${encodeURIComponent(app.id)}/revoke`, {
        method: 'POST', credentials: 'include', signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(true);
        if (response.status === 401 || response.status === 403) onCleared();
        return;
      }
      onCleared();
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  return <div>
    <button type="button" disabled={busy} onClick={() => void clear()}
      className="min-h-11 border border-gray-700 px-3 text-amber-300 disabled:opacity-50">
      {busy ? 'Clearing…' : 'Clear'}
    </button>
    {error && <p role="alert" className="text-red-400">Clear could not be confirmed. Refresh before trying again.</p>}
  </div>;
}

function AppRows({ apps, onCleared }: Readonly<{ apps: RegisteredApp[]; onCleared: () => void }>) {
  return <ul className="space-y-3">{apps.map(app => (
    <li key={app.id} className="min-w-0 space-y-2 border border-gray-800 p-3">
      <h3 className="text-sm font-semibold">{app.name}</h3>
      <p className="text-amber-300">{app.kind} · {app.status}</p>
      <p className="font-mono text-gray-500">{app.appDid}</p>
      <dl className="space-y-1 text-gray-400">
        <Provenance label="Created · registrar" point={app.created} />
        <Provenance label="First consent · by" point={app.firstConsent} fallback="none recorded" />
        <div><dt className="inline text-gray-300">Consenting principals (live)</dt>
          <dd className="inline"> · {app.consentingPrincipals}</dd></div>
        <div><dt className="inline text-gray-300">Last seen</dt><dd className="inline">
          {' · '}<Time at={app.lastSeen} />
        </dd></div>
        {(app.status === 'expired' || app.status === 'revoked') && (
          <Provenance label={app.status} point={app.ended} />
        )}
      </dl>
      {app.status === 'revoked' && app.revocationId && <details>
        <summary className="cursor-pointer py-2 text-amber-300">registry.app.revoked</summary>
        <p className="font-mono">Attestation · {app.revocationId}</p>
        <dl><Provenance label="Issued" point={app.ended} /></dl>
        <a className="inline-block py-2 text-amber-300 underline"
          href={`/auth/api/attestations?subject_did=${encodeURIComponent(app.appDid)}&type=registry.app.revoked`}>
          View signed attestation
        </a>
      </details>}
      {(app.status === 'active' || app.status === 'dormant') && <ClearApp app={app} onCleared={onCleared} />}
    </li>
  ))}</ul>;
}

/** Operator-only inventory preserves registry history; Clear uses the existing admin revoke route. */
export function RegisteredAppsPanel() {
  const [apps, setApps] = useState<RegisteredApp[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const result = await readRegisteredApps(current.signal);
        if (cancelled || current.signal.aborted) return;
        setApps(result); setError(false);
      } catch {
        if (!cancelled && !current.signal.aborted) { setApps(null); setError(true); }
      }
    };
    const sessionChanged = () => { setApps(null); setError(false); void load(); };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    globalThis.addEventListener('imajin:session-changed', sessionChanged);
    return () => {
      cancelled = true; controller?.abort(); clearInterval(timer);
      globalThis.removeEventListener('imajin:session-changed', sessionChanged);
    };
  }, [revision]);
  const refresh = () => setRevision(value => value + 1);
  if (!apps && !error) return null;
  const visible = apps?.filter(app => app.status === 'active' || app.status === 'dormant') ?? [];
  const expired = apps?.filter(app => app.status === 'expired') ?? [];
  const revoked = apps?.filter(app => app.status === 'revoked') ?? [];
  return (
    <section aria-label="Registered apps" className="mt-8 min-w-0 space-y-3 text-xs [overflow-wrap:anywhere]">
      <h2 className="text-base font-semibold text-gray-100">Registered apps</h2>
      <p className="text-gray-400">Registry history, including legacy apps. Clear revokes access, never deletes history. Dormant means no recorded
        token mint, refresh or validation in 90 days; it does not expire or revoke anything.</p>
      {error && <p role="alert" className="text-red-400">Registered apps unavailable. Retrying automatically.</p>}
      {apps?.length === 0 && <p className="text-gray-400">No registered apps.</p>}
      <AppRows apps={visible} onCleared={refresh} />
      {expired.length > 0 && <details className="border border-gray-800 p-3">
        <summary className="cursor-pointer py-2 text-gray-300">expired ({expired.length})</summary>
        <AppRows apps={expired} onCleared={refresh} />
      </details>}
      {revoked.length > 0 && <details className="border border-gray-800 p-3">
        <summary className="cursor-pointer py-2 text-gray-300">revoked ({revoked.length})</summary>
        <AppRows apps={revoked} onCleared={refresh} />
      </details>}
    </section>
  );
}
