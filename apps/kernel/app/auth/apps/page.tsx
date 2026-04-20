'use client';

import { useState, useEffect } from 'react';
import { SCOPES } from '@imajin/auth';
import type { Scope } from '@imajin/auth';

interface ConnectedApp {
  attestationId: string;
  appDid: string;
  appId: string | null;
  appName: string;
  appDescription: string | null;
  appHomepageUrl: string | null;
  appLogoUrl: string | null;
  appStatus: string;
  scopes: string[];
  authorizedAt: string;
  revokedAt: string | null;
}

function AppCard({
  app,
  onRevoke,
}: {
  app: ConnectedApp;
  onRevoke: (app: ConnectedApp) => void;
}) {
  const isRevoked = !!app.revokedAt;
  const initial = app.appName.charAt(0).toUpperCase();

  return (
    <div className={`rounded-lg border bg-zinc-900 p-5 flex gap-4 ${isRevoked ? 'border-zinc-800 opacity-60' : 'border-zinc-800'}`}>
      {/* Icon */}
      <div className="flex-shrink-0">
        {app.appLogoUrl ? (
          <img
            src={app.appLogoUrl}
            alt={app.appName}
            className="w-12 h-12 rounded-lg object-cover"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-lg font-semibold text-zinc-300">
            {initial}
          </div>
        )}
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-white">{app.appName}</span>
              {isRevoked && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">
                  Revoked
                </span>
              )}
            </div>
            {app.appDescription && (
              <p className="text-sm text-zinc-400 mt-0.5">{app.appDescription}</p>
            )}
            {app.appHomepageUrl && (
              <a
                href={app.appHomepageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-zinc-500 hover:text-zinc-400 mt-0.5 block truncate"
              >
                {app.appHomepageUrl}
              </a>
            )}
          </div>

          {!isRevoked && (
            <button
              onClick={() => onRevoke(app)}
              className="flex-shrink-0 text-sm px-3 py-1.5 rounded border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors"
            >
              Revoke
            </button>
          )}
        </div>

        {/* Scopes */}
        {app.scopes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {app.scopes.map((scope) => (
              <span
                key={scope}
                className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700"
              >
                {SCOPES[scope as Scope] ?? scope}
              </span>
            ))}
          </div>
        )}

        {/* Date */}
        <p className="text-xs text-zinc-600 mt-2">
          {isRevoked
            ? `Revoked ${new Date(app.revokedAt!).toLocaleDateString()}`
            : `Authorized ${new Date(app.authorizedAt).toLocaleDateString()}`}
        </p>
      </div>
    </div>
  );
}

function ConfirmRevokeDialog({
  app,
  onConfirm,
  onCancel,
  revoking,
}: {
  app: ConnectedApp;
  onConfirm: () => void;
  onCancel: () => void;
  revoking: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onCancel} />
      <div className="relative bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full shadow-xl">
        <h2 className="text-base font-semibold text-white mb-2">Revoke access?</h2>
        <p className="text-sm text-zinc-400 mb-5">
          <span className="text-white font-medium">{app.appName}</span> will no longer be able to
          access your data.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={revoking}
            className="px-4 py-2 text-sm rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={revoking}
            className="px-4 py-2 text-sm rounded border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
          >
            {revoking ? 'Revoking…' : 'Revoke access'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ConnectedAppsPage() {
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmApp, setConfirmApp] = useState<ConnectedApp | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/apps', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load apps');
        return res.json();
      })
      .then((data: { apps: ConnectedApp[] }) => setApps(data.apps))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function handleRevoke() {
    if (!confirmApp || revoking) return;
    setRevoking(true);
    try {
      const res = await fetch('/api/auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ attestationId: confirmApp.attestationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Revoke failed');
      }
      const appName = confirmApp.appName;
      setApps((prev) =>
        prev.map((a) =>
          a.attestationId === confirmApp.attestationId
            ? { ...a, revokedAt: new Date().toISOString() }
            : a
        )
      );
      setConfirmApp(null);
      showToast(`Access revoked for ${appName}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Revoke failed');
      setConfirmApp(null);
    } finally {
      setRevoking(false);
    }
  }

  const activeApps = apps.filter((a) => !a.revokedAt);
  const revokedApps = apps.filter((a) => a.revokedAt);

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-lg font-semibold text-white mb-1">Connected Apps</h1>
      <p className="text-sm text-zinc-500 mb-6">Apps you've authorized to access your account.</p>

      {loading && (
        <div className="text-sm text-zinc-500">Loading…</div>
      )}

      {error && (
        <div className="text-sm text-red-400">{error}</div>
      )}

      {!loading && !error && apps.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-4xl mb-3">🔌</span>
          <p className="text-zinc-400 text-sm">No apps connected.</p>
          <p className="text-zinc-600 text-sm">Apps you authorize will appear here.</p>
        </div>
      )}

      {!loading && !error && activeApps.length > 0 && (
        <div className="flex flex-col gap-3">
          {activeApps.map((app) => (
            <AppCard key={app.attestationId} app={app} onRevoke={setConfirmApp} />
          ))}
        </div>
      )}

      {!loading && !error && revokedApps.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-3">
            Previously authorized
          </h2>
          <div className="flex flex-col gap-3">
            {revokedApps.map((app) => (
              <AppCard key={app.attestationId} app={app} onRevoke={setConfirmApp} />
            ))}
          </div>
        </div>
      )}

      {confirmApp && (
        <ConfirmRevokeDialog
          app={confirmApp}
          onConfirm={handleRevoke}
          onCancel={() => setConfirmApp(null)}
          revoking={revoking}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
