'use client';

/**
 * /connections/connectors — Connectors status dashboard (#1354, read-only cut).
 *
 * Registry-driven: every connector in CONNECTOR_REGISTRY gets a card. GitHub
 * shows live status from GET /github/api/scope-manifest (config sealed, token
 * sealed, active scopes). Discord and QuickBooks render as "backend pending"
 * until their scope-manifest routes land (#1355, #1356).
 *
 * Write actions (configure form, connect button, scope toggles) are OUT OF
 * SCOPE for this cut. The write-toggle for on-consent scopes (github:write)
 * is blocked on #1357 (consent_grants writer). The page is structured so all
 * write surfaces can be added per-card without touching the registry or layout.
 */

import { useEffect, useState } from 'react';
import { useIdentity } from '../context/IdentityContext';
import {
  CONNECTOR_REGISTRY,
  type ConnectorEntry,
  type ReleaseClass,
} from '@/src/lib/kernel/connector-registry';

// ── Types ─────────────────────────────────────────────────────────────────────

interface GitHubStatus {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
  configSealed: boolean;
  tokenSealed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RELEASE_CLASS_LABEL: Record<ReleaseClass, string> = {
  silent: 'auto-grant',
  'on-consent': 'requires consent',
  never: 'never active',
};

const RELEASE_CLASS_COLOR: Record<ReleaseClass, string> = {
  silent: 'text-green-400',
  'on-consent': 'text-amber-400',
  never: 'text-gray-600',
};

function StatusDot({ ok, label }: Readonly<{ ok: boolean; label: string }>) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-400' : 'bg-gray-600'}`} />
      <span className={ok ? 'text-white' : 'text-gray-500'}>{label}</span>
    </span>
  );
}

function Badge({ children, variant }: Readonly<{ children: React.ReactNode; variant: 'pending' | 'active' | 'inactive' | 'info' }>) {
  const styles = {
    pending: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30',
    active: 'bg-green-500/10 text-green-400 border border-green-500/30',
    inactive: 'bg-white/5 text-gray-500 border border-white/10',
    info: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[variant]}`}>
      {children}
    </span>
  );
}

// ── GitHub card (live data) ───────────────────────────────────────────────────

function GitHubConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(entry.statusEndpoint!)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<GitHubStatus>;
      })
      .then(setStatus)
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [entry.statusEndpoint]);

  const activeSet = new Set(status?.activeScopes ?? []);

  // Derive an overall connection health: all three steps must be green for tools to work
  const readyForRead =
    status !== null &&
    status.configSealed &&
    status.tokenSealed &&
    activeSet.has('github:read');

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{entry.icon}</span>
          <div>
            <h2 className="text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-sm text-gray-400">{entry.description}</p>
          </div>
        </div>
        <div>
          {loading ? (
            <Badge variant="info">Checking…</Badge>
          ) : error ? (
            <Badge variant="inactive">Unavailable</Badge>
          ) : readyForRead ? (
            <Badge variant="active">● Connected</Badge>
          ) : (
            <Badge variant="inactive">○ Not ready</Badge>
          )}
        </div>
      </div>

      {loading && (
        <p className="text-gray-500 text-sm">Loading status…</p>
      )}

      {error && (
        <p className="text-red-400 text-sm">Could not load status: {error}</p>
      )}

      {!loading && !error && status && (
        <>
          {/* ── Credential status ── */}
          <div className="mb-5">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Credential
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-400">OAuth App config</span>
                <StatusDot ok={status.configSealed} label={status.configSealed ? 'Sealed' : 'Not configured'} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Access token</span>
                <StatusDot ok={status.tokenSealed} label={status.tokenSealed ? 'Connected' : 'Not connected'} />
              </div>
            </div>

            {!status.configSealed && (
              <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-xs text-amber-300/80">
                Configure your GitHub OAuth App to continue:
                <code className="block mt-1 font-mono text-amber-200/60">
                  POST /github/api/configure {'{'} clientId, clientSecret, redirectUri {'}'}
                </code>
              </div>
            )}

            {status.configSealed && !status.tokenSealed && (
              <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-xs text-amber-300/80">
                Connect your GitHub account via OAuth:
                <code className="block mt-1 font-mono text-amber-200/60">
                  GET /github/api/connect  (open in browser with active session)
                </code>
              </div>
            )}
          </div>

          {/* ── Scope grants ── */}
          <div className="mb-5">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Scope grants
            </h3>
            <div className="space-y-2">
              {entry.scopes.map((scope) => {
                const isActive = activeSet.has(scope.name);
                const isOnConsent = scope.releaseClass === 'on-consent';
                return (
                  <div
                    key={scope.name}
                    className="flex items-center justify-between py-2 border-b border-white/5 last:border-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-base ${isActive ? '' : 'opacity-30'}`}>
                        {isActive ? '✓' : '○'}
                      </span>
                      <div className="min-w-0">
                        <span className={`text-sm font-mono ${isActive ? 'text-white' : 'text-gray-500'}`}>
                          {scope.name}
                        </span>
                        <p className="text-xs text-gray-500 truncate">{scope.label}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      <span className={`text-xs ${RELEASE_CLASS_COLOR[scope.releaseClass]}`}>
                        {RELEASE_CLASS_LABEL[scope.releaseClass]}
                      </span>
                      {isActive ? (
                        <Badge variant="active">Active</Badge>
                      ) : isOnConsent ? (
                        <Badge variant="pending">Pending #1357</Badge>
                      ) : (
                        <Badge variant="inactive">Not granted</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {status.tokenSealed && status.activeScopes.length === 0 && (
              <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-xs text-amber-300/80">
                No scopes granted yet. Grant <code className="font-mono">github:read</code> to enable read tools:
                <code className="block mt-1 font-mono text-amber-200/60">
                  POST /github/api/scope-manifest {'{"scopes":["github:read"]}'}
                </code>
              </div>
            )}
          </div>

          {/* ── Asset anchor ── */}
          {status.manifestAssetId && (
            <div className="text-xs text-gray-600 font-mono truncate" title="Scope-manifest asset ID">
              manifest: {status.manifestAssetId}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Pending connector card (no backend yet) ───────────────────────────────────

function PendingConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const issueRef = entry.id === 'discord' ? '#1355' : entry.id === 'quickbooks' ? '#1356' : null;
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-6 opacity-60">
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{entry.icon}</span>
          <div>
            <h2 className="text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-sm text-gray-400">{entry.description}</p>
          </div>
        </div>
        <Badge variant="pending">Backend pending</Badge>
      </div>

      <div className="space-y-1 mb-4">
        {entry.scopes.map((scope) => (
          <div key={scope.name} className="flex items-center gap-2 text-sm text-gray-600">
            <span>○</span>
            <span className="font-mono text-xs">{scope.name}</span>
            <span className="text-gray-700">—</span>
            <span className="text-xs">{scope.label}</span>
          </div>
        ))}
      </div>

      {issueRef && (
        <p className="text-xs text-gray-600">
          Scope-manifest publish route and credential ingestion land in {issueRef}.
          The Connectors page will show live status once that backend ships.
        </p>
      )}
    </div>
  );
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function ConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  if (entry.backendPending) return <PendingConnectorCard entry={entry} />;
  if (entry.id === 'github') return <GitHubConnectorCard entry={entry} />;
  // Future: each connector with a backend gets its own card component here.
  return <PendingConnectorCard entry={entry} />;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ConnectorsPage() {
  const { isLoggedIn, loading } = useIdentity();

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-gray-400">
        Loading…
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">🔌</div>
        <h1 className="text-3xl font-bold mb-3">Connectors</h1>
        <p className="text-gray-400 mb-8">Sign in to view your connector status.</p>
        <a
          href="/auth/api/login"
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Connectors</h1>
          <p className="text-gray-400 text-sm mt-1">
            Connect third-party services to enable AI tools acting on your behalf.
          </p>
        </div>
        <a
          href="/connections"
          className="text-sm text-gray-500 hover:text-gray-300 transition"
        >
          ← Connections
        </a>
      </div>

      {/* Connector cards */}
      <div className="space-y-4">
        {CONNECTOR_REGISTRY.map((entry) => (
          <ConnectorCard key={entry.id} entry={entry} />
        ))}
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-gray-700 mt-8">
        Write actions (configure, connect, scope grants) land in the next cut after #1357 (consent backend).
      </p>
    </div>
  );
}
