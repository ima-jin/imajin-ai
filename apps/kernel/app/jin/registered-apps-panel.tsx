'use client';

import { useEffect, useState } from 'react';
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
function AppRows({ apps }: Readonly<{ apps: RegisteredApp[] }>) {
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
          <Provenance label={`${app.status} · by`} point={app.ended} />
        )}
      </dl>
    </li>
  ))}</ul>;
}

/** Read-only operator inventory; no registry lifecycle actions live here. */
export function RegisteredAppsPanel() {
  const [apps, setApps] = useState<RegisteredApp[] | null>(null);
  const [error, setError] = useState(false);
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
  }, []);
  if (!apps && !error) return null;
  const visible = apps?.filter(app => app.status !== 'expired') ?? [];
  const expired = apps?.filter(app => app.status === 'expired') ?? [];
  return (
    <section aria-label="Registered apps" className="mt-8 min-w-0 space-y-3 text-xs [overflow-wrap:anywhere]">
      <h2 className="text-base font-semibold text-gray-100">Registered apps</h2>
      <p className="text-gray-400">Read-only registry history, including legacy apps. Dormant means no recorded
        token mint, refresh or validation in 90 days; it does not expire or revoke anything.</p>
      {error && <p role="alert" className="text-red-400">Registered apps unavailable. Retrying automatically.</p>}
      {apps?.length === 0 && <p className="text-gray-400">No registered apps.</p>}
      <AppRows apps={visible} />
      {expired.length > 0 && <details className="border border-gray-800 p-3">
        <summary className="cursor-pointer py-2 text-gray-300">expired ({expired.length})</summary>
        <AppRows apps={expired} />
      </details>}
    </section>
  );
}
