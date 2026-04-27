'use client';

import { useState } from 'react';
import Link from 'next/link';
import RegisterAppForm from './RegisterAppForm';

interface App {
  id: string;
  name: string;
  description: string | null;
  appDid: string;
  status: string;
  requestedScopes: string[] | null;
  createdAt: Date | string | null;
}

interface RegisteredApp {
  id: string;
  appDid: string;
  name: string;
}

interface Props {
  apps: App[];
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={copy}
      className="text-[10px] text-muted hover:text-warning transition-colors ml-1"
      title="Copy"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function SuccessBanner({ app, onDismiss }: { app: RegisteredApp; onDismiss: () => void }) {
  return (
    <div className="bg-success/20 border border-green-800/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-success">App registered successfully</p>
        <button onClick={onDismiss} className="text-muted hover:text-zinc-300 text-xs transition-colors">
          Dismiss
        </button>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted w-16 shrink-0">App ID</span>
          <span className="text-xs font-mono text-zinc-300">{app.id}</span>
          <CopyButton text={app.id} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted w-16 shrink-0">App DID</span>
          <span className="text-xs font-mono text-zinc-300 break-all">{app.appDid}</span>
          <CopyButton text={app.appDid} />
        </div>
      </div>
      <Link
        href={`/auth/developer/apps/${app.id}`}
        className="inline-block text-xs text-warning hover:text-warning/70 transition-colors"
      >
        View app details →
      </Link>
    </div>
  );
}

function AppCard({ app }: { app: App }) {
  const createdAt = app.createdAt ? new Date(app.createdAt).toLocaleDateString() : '—';
  const scopes = (app.requestedScopes ?? []) as string[];

  return (
    <div className="bg-surface-base border border-white/10 p-4 hover:border-white/10 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-primary truncate font-mono">{app.name}</h3>
            <span className={`text-[10px] px-1.5 py-0.5 border shrink-0 ${
              app.status === 'active'
                ? 'bg-success/30 border-green-800/50 text-success'
                : 'bg-error/30 border-red-800/50 text-error'
            }`}>
              {app.status}
            </span>
          </div>
          {app.description && (
            <p className="text-xs text-secondary mb-2 line-clamp-2">{app.description}</p>
          )}
          <div className="flex items-center gap-1 mb-2">
            <span className="text-[10px] font-mono text-muted truncate">{app.appDid}</span>
            <CopyButton text={app.appDid} />
          </div>
          {scopes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {scopes.slice(0, 4).map(scope => (
                <span key={scope} className="text-[10px] px-1.5 py-0.5 bg-surface-elevated border border-white/10 text-secondary font-mono">
                  {scope}
                </span>
              ))}
              {scopes.length > 4 && (
                <span className="text-[10px] px-1.5 py-0.5 bg-surface-elevated border border-white/10 text-muted">
                  +{scopes.length - 4} more
                </span>
              )}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] text-muted mb-2">{createdAt}</p>
          <Link
            href={`/auth/developer/apps/${app.id}`}
            className="text-xs text-warning hover:text-warning/70 transition-colors"
          >
            Manage →
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function DevAppsShell({ apps: initialApps }: Props) {
  const [apps, setApps] = useState<App[]>(initialApps);
  const [showForm, setShowForm] = useState(false);
  const [newApp, setNewApp] = useState<RegisteredApp | null>(null);

  function handleSuccess(app: RegisteredApp) {
    setNewApp(app);
    setShowForm(false);
    // Reload to pick up new app from server
    window.location.reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-primary font-mono">Developer Apps</h1>
          <p className="text-xs text-muted mt-0.5">Apps registered under your identity</p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="px-3 py-2 bg-warning hover:bg-warning text-black text-sm font-semibold transition-colors"
          >
            Register new app
          </button>
        )}
      </div>

      {newApp && <SuccessBanner app={newApp} onDismiss={() => setNewApp(null)} />}

      {showForm && (
        <RegisterAppForm
          onSuccess={handleSuccess}
          onCancel={() => setShowForm(false)}
        />
      )}

      {apps.length === 0 && !showForm ? (
        <div className="bg-surface-base border border-white/10 p-8 text-center">
          <p className="text-2xl mb-3">🔑</p>
          <p className="text-sm text-secondary mb-4">No apps registered yet.</p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-warning hover:bg-warning text-black text-sm font-semibold transition-colors"
          >
            Register your first app
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {apps.map(app => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
