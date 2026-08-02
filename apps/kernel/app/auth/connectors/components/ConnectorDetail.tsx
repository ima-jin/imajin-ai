'use client';

/**
 * ConnectorDetail — the per-connector configure/scope/disconnect view.
 *
 * Extracted from the old monolithic /auth/connectors page (#1494) so the
 * connectors landing can become a registry-driven grid that links into this
 * detail view at /auth/connectors/[id]. Behavior is unchanged from #1354 +
 * #1397 + #1490:
 *   ingestionPattern === 'native'      → NativeConnectorCard (scope toggles only)
 *   ingestionPattern === 'oauth'       → per-connector OAuth card
 *   ingestionPattern === 'token-paste' → per-connector token-paste card
 * All on-consent scopes use grant-by-edit — toggling in the UI writes the
 * consent_grants row automatically.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectorEntry,
  type ConnectorScope,
  type ReleaseClass,
} from '@/src/lib/kernel/connector-registry';

// ── Types ─────────────────────────────────────────────────────

interface GitHubStatus {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
  configSealed: boolean;
  tokenSealed: boolean;
  /** Sealed but awaiting owner grant approval (Tier 1, #1521) — not the same as "not configured". */
  credentialPending?: boolean;
}

interface DiscordStatus {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
  tokenSealed: boolean;
  credentialPending?: boolean;
}

/** Same shape as GitHubStatus — QuickBooks is also Pattern A (OAuth). */
interface QuickBooksStatus {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
  configSealed: boolean;
  tokenSealed: boolean;
  credentialPending?: boolean;
}

/**
 * Native connector status — no credential booleans.
 * The connector is credential-free; enabling it is purely scope toggles.
 */
interface NativeStatus {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
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

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * POST a scope-delta to a connector scope-manifest endpoint and return the new
 * activeScopes list from the response.
 *
 * Pure function — no React state side effects. Extracted to eliminate the
 * four-way duplication of this pattern across GitHub, Discord, QuickBooks, and
 * Native connector cards (Sonar dedup fix, #1408).
 *
 * NOTE: applies the toggle locally (add/remove from currentActiveScopes) before
 * POSTing so the request always reflects the full desired scope set, not just
 * the changed scope. Returns the server-confirmed activeScopes from the response.
 */
async function postScopeToggle(
  statusEndpoint: string,
  currentActiveScopes: string[],
  scopeName: string,
  enable: boolean,
): Promise<string[]> {
  const next = new Set(currentActiveScopes);
  if (enable) next.add(scopeName);
  else next.delete(scopeName);

  const r = await fetch(statusEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes: [...next] }),
  });
  // Read body once regardless of status — needed for both the error message and
  // the activeScopes on success.
  const data = await r.json().catch(() => ({})) as { error?: string; activeScopes?: string[] };
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  // Prefer the server-confirmed list; fall back to the locally-computed set so
  // the UI stays optimistic on connectors that omit activeScopes in the response.
  return Array.isArray(data.activeScopes) ? data.activeScopes : [...next];
}

// ── Shared subcomponents ──────────────────────────────────────────────────────

/** Header badge for connector cards — eliminates nested ternary duplication. */
function ConnectorStatusBadge({ loading, error, ready, pending }: Readonly<{
  loading: boolean; error: boolean; ready: boolean; pending?: boolean;
}>) {
  if (loading) return <Badge variant="info">Checking…</Badge>;
  if (error) return <Badge variant="inactive">Unavailable</Badge>;
  if (ready) return <Badge variant="active">● Connected</Badge>;
  // Sealed but not yet granted by the owner agent (Tier 1) — distinct from
  // "not configured", which would tell the user to redo work they already did.
  if (pending) return <Badge variant="pending">⏳ Waiting for owner approval</Badge>;
  return <Badge variant="inactive">○ Not configured</Badge>;
}

/** One scope row inside a ScopeGrantSection. */
function ScopeRow({ scope, isActive, isGranting, isAnyGranting, tokenSealed, onToggle }: Readonly<{
  scope: ConnectorScope; isActive: boolean; isGranting: boolean;
  isAnyGranting: boolean; tokenSealed: boolean;
  onToggle: (name: string, enable: boolean) => void;
}>) {
  const isLocked = scope.releaseClass === 'never';
  let badge: React.ReactNode;
  if (isGranting) badge = <Badge variant="info">Saving…</Badge>;
  else if (isLocked) badge = <Badge variant="inactive">N/A</Badge>;
  else if (isActive) badge = <Badge variant="active">Active</Badge>;
  else badge = (
    <Badge variant="inactive">
      <span className={RELEASE_CLASS_COLOR[scope.releaseClass]}>
        {RELEASE_CLASS_LABEL[scope.releaseClass]}
      </span>
    </Badge>
  );
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
      <label
        className={`flex items-center gap-3 min-w-0 ${isLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
        aria-label={scope.label}
      >
        <input
          type="checkbox"
          checked={isActive}
          disabled={isLocked || !tokenSealed || isGranting || isAnyGranting}
          onChange={(e) => { onToggle(scope.name, e.target.checked); }}
          className="w-4 h-4 rounded accent-amber-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <div className="min-w-0">
          <span className={`text-sm font-mono block ${isActive ? 'text-white' : 'text-gray-400'}`}>
            {scope.name}
          </span>
          <span className="text-xs text-gray-600 truncate block">{scope.label}</span>
        </div>
      </label>
      <div className="flex items-center gap-2 shrink-0 ml-4">{badge}</div>
    </div>
  );
}

/** Shared scope-grant section — used by GitHub, Discord, and QuickBooks. */
function ScopeGrantSection({ entry, activeSet, stepNumber, grantingScope, grantError, tokenSealed, noTokenHint, onToggle }: Readonly<{
  entry: ConnectorEntry; activeSet: Set<string>; stepNumber: string | number;
  grantingScope: string | null; grantError: string | null;
  tokenSealed: boolean; noTokenHint: string;
  onToggle: (name: string, enable: boolean) => void;
}>) {
  const hasActive = activeSet.size > 0;
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 mb-3">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
          hasActive ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
        }`}>
          {hasActive ? '✓' : stepNumber}
        </span>
        {'  '}Scope grants
      </h3>
      {grantError && <p className="text-red-400 text-xs mb-2">{grantError}</p>}
      <div className="space-y-1">
        {entry.scopes.map((scope) => (
          <ScopeRow
            key={scope.name}
            scope={scope}
            isActive={activeSet.has(scope.name)}
            isGranting={grantingScope === scope.name}
            isAnyGranting={grantingScope !== null}
            tokenSealed={tokenSealed}
            onToggle={onToggle}
          />
        ))}
      </div>
      {!tokenSealed && <p className="text-xs text-gray-600 mt-2">{noTokenHint}</p>}
    </div>
  );
}

// ── Shared disconnect hook + component ──────────────────────────────────────────────

/**
 * Encapsulates the disconnect state + handler shared by all connector cards
 * (GitHub, Discord, QuickBooks). Deduplicated from the three near-identical
 * inline copies that previously lived in each card (#1490 Sonar fix).
 *
 * @param disconnectRoute  The `entry.disconnectRoute` POST URL.
 * @param confirmMessage   Text shown in the browser confirm dialog.
 * @param onSuccess        Called (synchronously) after a successful disconnect;
 *                         typically `() => { void fetchStatus(); }`.
 */
function useDisconnect(
  disconnectRoute: string,
  confirmMessage: string,
  onSuccess: () => void,
) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function handleDisconnect() {
    if (!window.confirm(confirmMessage)) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const r = await fetch(disconnectRoute, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
      onSuccess();
    } catch (err: unknown) {
      setDisconnectError(String(err));
    } finally {
      setDisconnecting(false);
    }
  }

  return { disconnecting, disconnectError, handleDisconnect };
}

/**
 * Danger-styled disconnect button + error message. Rendered at the bottom of
 * each connector card when credentials are sealed. Shared across all three
 * connector cards to eliminate JSX duplication (#1490 Sonar fix).
 */
function DisconnectSection({ label, disconnecting, disconnectError, onDisconnect }: Readonly<{
  label: string;
  disconnecting: boolean;
  disconnectError: string | null;
  onDisconnect: () => void;
}>) {
  return (
    <div className="pt-3 border-t border-white/5">
      {disconnectError && <p className="text-red-400 text-xs mb-2">{disconnectError}</p>}
      <button
        type="button"
        onClick={onDisconnect}
        disabled={disconnecting}
        className="px-4 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm rounded-lg transition disabled:opacity-50"
      >
        {disconnecting ? 'Disconnecting…' : label}
      </button>
    </div>
  );
}

// ── GitHub card (interactive: configure → connect → grant) — #1352 ─────────

function GitHubConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Configure form state
  const [showConfigure, setShowConfigure] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const clientIdRef = useRef<HTMLInputElement>(null);

  // Scope grant state
  const [grantingScope, setGrantingScope] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  // Prefill redirectUri from current origin (only in browser)
  useEffect(() => {
    setRedirectUri(`${window.location.origin}/github/api/callback`);
  }, []);

  // Focus first field when form opens
  useEffect(() => {
    if (showConfigure) clientIdRef.current?.focus();
  }, [showConfigure]);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus(await r.json() as GitHubStatus);
    } catch (err: unknown) {
      setStatusError(String(err));
    } finally {
      setStatusLoading(false);
    }
  }, [entry.statusEndpoint]);

  // Background refresh — does not blank the card (no statusLoading = true).
  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) return;
      setStatus(await r.json() as GitHubStatus);
      setStatusError(null);
    } catch { /* non-fatal */ }
  }, [entry.statusEndpoint]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const { disconnecting, disconnectError, handleDisconnect } = useDisconnect(
    entry.disconnectRoute!,
    'Disconnect GitHub? This will revoke the grant and delete all sealed credentials.',
    () => { void fetchStatus(); },
  );

  const activeSet = new Set(status?.activeScopes ?? []);
  const readyForRead =
    status !== null && status.configSealed && status.tokenSealed && activeSet.has('github:read');

  // ── Step 1: Configure OAuth App ────────────────────────────────────────────
  async function handleConfigure(e: React.FormEvent) {
    e.preventDefault();
    setConfiguring(true);
    setConfigError(null);
    try {
      const r = await fetch('/github/api/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: redirectUri.trim() }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
      setShowConfigure(false);
      setClientId('');
      setClientSecret('');
      void refreshStatus();
    } catch (err: unknown) {
      setConfigError(String(err));
    } finally {
      setConfiguring(false);
    }
  }

  // ── Step 3: Toggle a scope in the manifest ─────────────────────────────────
  async function handleToggleScope(scopeName: string, enable: boolean) {
    setGrantingScope(scopeName);
    setGrantError(null);
    try {
      // Apply POST response directly — no card blank-out, no reactor race.
      // configSealed/tokenSealed don't change on a scope toggle, so we avoid
      // a refreshStatus() GET that would race the projection reactor.
      const newScopes = await postScopeToggle(entry.statusEndpoint!, status?.activeScopes ?? [], scopeName, enable);
      setStatus(prev => prev ? { ...prev, activeScopes: newScopes } : prev);
    } catch (err: unknown) {
      setGrantError(String(err));
    } finally {
      setGrantingScope(null);
    }
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{entry.icon}</span>
          <div>
            <h2 className="text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-sm text-gray-400">{entry.description}</p>
          </div>
        </div>
        <ConnectorStatusBadge
          loading={statusLoading}
          error={!!statusError}
          ready={readyForRead}
          pending={status?.credentialPending}
        />
      </div>

      {statusLoading && <p className="text-gray-500 text-sm">Loading status…</p>}
      {statusError && <p className="text-red-400 text-sm">Could not load status: {statusError}</p>}

      {!statusLoading && !statusError && status && (
        <div className="space-y-6">

          {/* ── Step 1: Configure OAuth App ── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                  status.configSealed ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
                }`}>
                  {status.configSealed ? '✓' : '1'}
                </span>
                {' '}OAuth App
              </h3>
              {status.configSealed && !showConfigure && (
                <button
                  type="button"
                  onClick={() => setShowConfigure(true)}
                  className="text-xs text-gray-600 hover:text-gray-400 transition"
                >
                  Update
                </button>
              )}
            </div>

            {!status.configSealed || showConfigure ? (
              <form onSubmit={(e) => { void handleConfigure(e); }} className="space-y-2">
                <input
                  ref={clientIdRef}
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="OAuth App Client ID"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
                />
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Client Secret"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
                />
                <input
                  type="url"
                  value={redirectUri}
                  onChange={(e) => setRedirectUri(e.target.value)}
                  placeholder="Redirect URI"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
                />
                {configError && <p className="text-red-400 text-xs">{configError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={configuring || !clientId.trim() || !clientSecret.trim() || !redirectUri.trim()}
                    className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-sm font-medium rounded-lg transition"
                  >
                    {configuring ? 'Saving…' : (status.configSealed ? 'Update config' : 'Save config')}
                  </button>
                  {showConfigure && (
                    <button
                      type="button"
                      onClick={() => { setShowConfigure(false); setConfigError(null); }}
                      className="px-4 py-1.5 bg-white/5 hover:bg-white/10 text-gray-400 text-sm rounded-lg transition"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <StatusDot ok={true} label="OAuth App config sealed" />
              </div>
            )}
          </div>

          {/* ── Step 2: Connect GitHub Account ── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 mb-3">
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                status.tokenSealed ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
              }`}>
                {status.tokenSealed ? '✓' : '2'}
              </span>
              {' '}GitHub Account
            </h3>

            {status.tokenSealed ? (
              <div className="flex items-center justify-between text-sm">
                <StatusDot ok={true} label="Account connected" />
                <a
                  href={entry.connectRoute!}
                  className="text-xs text-gray-600 hover:text-gray-400 transition"
                >
                  Reconnect
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                <a
                  href={entry.connectRoute!}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                    status.configSealed
                      ? 'bg-amber-500 hover:bg-amber-600 text-black'
                      : 'bg-white/5 text-gray-600 cursor-not-allowed pointer-events-none'
                  }`}
                  aria-disabled={!status.configSealed}
                >
                  Connect GitHub Account →
                </a>
                {!status.configSealed && (
                  <p className="text-xs text-gray-600">Complete step 1 first.</p>
                )}
              </div>
            )}
          </div>

          {/* ── Step 3: Grant scopes ── */}
          <ScopeGrantSection
            entry={entry}
            activeSet={activeSet}
            stepNumber={3}
            grantingScope={grantingScope}
            grantError={grantError}
            tokenSealed={status.tokenSealed}
            noTokenHint="Connect your account (step 2) to enable scope grants."
            onToggle={(name, enable) => { void handleToggleScope(name, enable); }}
          />

          {/* Asset anchor */}
          {status.manifestAssetId && (
            <div className="text-xs text-gray-700 font-mono truncate pt-1 border-t border-white/5" title="Scope-manifest asset ID">
              manifest: {status.manifestAssetId}
            </div>
          )}

          {/* Disconnect */}
          {(status.configSealed || status.tokenSealed) && (
            <DisconnectSection
              label="Disconnect GitHub"
              disconnecting={disconnecting}
              disconnectError={disconnectError}
              onDisconnect={() => { void handleDisconnect(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Discord card (token-paste, Pattern B) ────────────────────────────────────────────────────────────────

function DiscordConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Token paste state
  const [tokenInput, setTokenInput] = useState('');
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);

  // Scope grant state
  const [grantingScope, setGrantingScope] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus(await r.json() as DiscordStatus);
    } catch (err: unknown) {
      setStatusError(String(err));
    } finally {
      setStatusLoading(false);
    }
  }, [entry.statusEndpoint]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) return;
      setStatus(await r.json() as DiscordStatus);
      setStatusError(null);
    } catch { /* non-fatal */ }
  }, [entry.statusEndpoint]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const { disconnecting, disconnectError, handleDisconnect } = useDisconnect(
    entry.disconnectRoute!,
    'Disconnect Discord? This will revoke the grant and delete the sealed bot token.',
    () => { void fetchStatus(); },
  );

  const activeSet = new Set(status?.activeScopes ?? []);
  const readyForPost = status !== null && status.tokenSealed && activeSet.has('discord:post');

  async function handleSealToken(e: React.FormEvent) {
    e.preventDefault();
    setSealing(true);
    setSealError(null);
    try {
      const r = await fetch(entry.tokenRoute!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
      setTokenInput('');
      setShowTokenInput(false);
      void refreshStatus();
    } catch (err: unknown) {
      setSealError(String(err));
    } finally {
      setSealing(false);
    }
  }

  async function handleToggleScope(scopeName: string, enable: boolean) {
    setGrantingScope(scopeName);
    setGrantError(null);
    try {
      const newScopes = await postScopeToggle(entry.statusEndpoint!, status?.activeScopes ?? [], scopeName, enable);
      setStatus(prev => prev ? { ...prev, activeScopes: newScopes } : prev);
    } catch (err: unknown) {
      setGrantError(String(err));
    } finally {
      setGrantingScope(null);
    }
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{entry.icon}</span>
          <div>
            <h2 className="text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-sm text-gray-400">{entry.description}</p>
          </div>
        </div>
        <ConnectorStatusBadge
          loading={statusLoading}
          error={!!statusError}
          ready={readyForPost}
          pending={status?.credentialPending}
        />
      </div>

      {statusLoading && <p className="text-gray-500 text-sm">Loading status…</p>}
      {statusError && <p className="text-red-400 text-sm">Could not load status: {statusError}</p>}

      {!statusLoading && !statusError && status && (
        <div className="space-y-6">

          {/* ── Step 1: Bot Token ── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                  status.tokenSealed ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
                }`}>
                  {status.tokenSealed ? '✓' : '1'}
                </span>
                {' '}Bot Token
              </h3>
              {status.tokenSealed && !showTokenInput && (
                <button type="button"
                  onClick={() => setShowTokenInput(true)}
                  className="text-xs text-gray-600 hover:text-gray-400 transition"
                >
                  Replace
                </button>
              )}
            </div>

            {!status.tokenSealed || showTokenInput ? (
              <form onSubmit={(e) => { void handleSealToken(e); }} className="space-y-2">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Discord Bot Token"
                  required
                  autoComplete="off"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 font-mono"
                />
                <p className="text-xs text-gray-700">Token is sealed server-side and never returned. Found in Discord Developer Portal → Bot → Token.</p>
                {sealError && <p className="text-red-400 text-xs">{sealError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={sealing || !tokenInput.trim()}
                    className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-sm font-medium rounded-lg transition"
                  >
                    {sealing ? 'Sealing…' : status.tokenSealed ? 'Replace token' : 'Seal token'}
                  </button>
                  {showTokenInput && (
                    <button type="button" onClick={() => { setShowTokenInput(false); setSealError(null); }}
                      className="px-4 py-1.5 bg-white/5 hover:bg-white/10 text-gray-400 text-sm rounded-lg transition">
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <StatusDot ok={true} label="Bot token sealed" />
            )}
          </div>

          {/* ── Step 2: Scope grants ── */}
          <ScopeGrantSection
            entry={entry}
            activeSet={activeSet}
            stepNumber={2}
            grantingScope={grantingScope}
            grantError={grantError}
            tokenSealed={status.tokenSealed}
            noTokenHint="Seal a bot token (step 1) to enable scope grants."
            onToggle={(name, enable) => { void handleToggleScope(name, enable); }}
          />


          {status.manifestAssetId && (
            <div className="text-xs text-gray-700 font-mono truncate pt-1 border-t border-white/5" title="Scope-manifest asset ID">
              manifest: {status.manifestAssetId}
            </div>
          )}

          {/* Disconnect */}
          {status.tokenSealed && (
            <DisconnectSection
              label="Disconnect Discord"
              disconnecting={disconnecting}
              disconnectError={disconnectError}
              onDisconnect={() => { void handleDisconnect(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── QuickBooks card (Pattern A — OAuth, like GitHub) ─────────────────────────────────────────────────────

function QuickBooksConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<QuickBooksStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [showConfigure, setShowConfigure] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('sandbox');
  const [configuring, setConfiguring] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const [grantingScope, setGrantingScope] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  useEffect(() => { setRedirectUri(`${window.location.origin}/quickbooks/api/callback`); }, []);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true); setStatusError(null);
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus(await r.json() as QuickBooksStatus);
    } catch (err: unknown) { setStatusError(String(err)); }
    finally { setStatusLoading(false); }
  }, [entry.statusEndpoint]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) return;
      setStatus(await r.json() as QuickBooksStatus);
      setStatusError(null);
    } catch { /* non-fatal */ }
  }, [entry.statusEndpoint]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const { disconnecting, disconnectError, handleDisconnect } = useDisconnect(
    entry.disconnectRoute!,
    'Disconnect QuickBooks? This will revoke the grant and delete all sealed credentials.',
    () => { void fetchStatus(); },
  );

  const activeSet = new Set(status?.activeScopes ?? []);
  const readyForRead = status !== null && status.configSealed && status.tokenSealed && activeSet.has('quickbooks:read');

  async function handleConfigure(e: React.FormEvent) {
    e.preventDefault(); setConfiguring(true); setConfigError(null);
    try {
      const r = await fetch('/quickbooks/api/configure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: redirectUri.trim(), environment }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})) as { error?: string }; throw new Error(d.error ?? `${r.status}`); }
      setShowConfigure(false); setClientId(''); setClientSecret('');
      void refreshStatus();
    } catch (err: unknown) { setConfigError(String(err)); }
    finally { setConfiguring(false); }
  }

  async function handleToggleScope(scopeName: string, enable: boolean) {
    setGrantingScope(scopeName); setGrantError(null);
    try {
      const newScopes = await postScopeToggle(entry.statusEndpoint!, status?.activeScopes ?? [], scopeName, enable);
      setStatus(prev => prev ? { ...prev, activeScopes: newScopes } : prev);
    } catch (err: unknown) { setGrantError(String(err)); }
    finally { setGrantingScope(null); }
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-6">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{entry.icon}</span>
          <div><h2 className="text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-sm text-gray-400">{entry.description}</p></div>
        </div>
        <ConnectorStatusBadge
          loading={statusLoading}
          error={!!statusError}
          ready={readyForRead}
          pending={status?.credentialPending}
        />
      </div>

      {statusLoading && <p className="text-gray-500 text-sm">Loading status…</p>}
      {statusError && <p className="text-red-400 text-sm">Could not load status: {statusError}</p>}

      {!statusLoading && !statusError && status && (
        <div className="space-y-6">
          {/* Step 1: Configure OAuth App */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                  status.configSealed ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'}`}>
                  {status.configSealed ? '✓' : '1'}
                </span>
                {' '}OAuth App (Intuit)
              </h3>
              {status.configSealed && !showConfigure && (
                <button type="button" onClick={() => setShowConfigure(true)} className="text-xs text-gray-600 hover:text-gray-400 transition">Update</button>
              )}
            </div>
            {!status.configSealed || showConfigure ? (
              <form onSubmit={(e) => { void handleConfigure(e); }} className="space-y-2">
                <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50" />
                <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client Secret" required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50" />
                <input type="url" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder="Redirect URI" required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50" />
                <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'sandbox' | 'production')}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50">
                  <option value="sandbox">Sandbox</option>
                  <option value="production">Production</option>
                </select>
                {configError && <p className="text-red-400 text-xs">{configError}</p>}
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={configuring || !clientId.trim() || !clientSecret.trim()}
                    className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-sm font-medium rounded-lg transition">
                    {configuring ? 'Saving…' : (status.configSealed ? 'Update config' : 'Save config')}
                  </button>
                  {showConfigure && (
                    <button type="button" onClick={() => { setShowConfigure(false); setConfigError(null); }}
                      className="px-4 py-1.5 bg-white/5 hover:bg-white/10 text-gray-400 text-sm rounded-lg transition">Cancel</button>
                  )}
                </div>
              </form>
            ) : (
              <StatusDot ok={true} label="Intuit app config sealed" />
            )}
          </div>

          {/* Step 2: Connect QuickBooks Account */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 mb-3">
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                status.tokenSealed ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'}`}>
                {status.tokenSealed ? '✓' : '2'}
              </span>
              {' '}QuickBooks Account
            </h3>
            {status.tokenSealed ? (
              <div className="flex items-center justify-between text-sm">
                <StatusDot ok={true} label="Account connected" />
                <a href={entry.connectRoute!} className="text-xs text-gray-600 hover:text-gray-400 transition">Reconnect</a>
              </div>
            ) : (
              <div className="space-y-2">
                <a href={entry.connectRoute!}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                    status.configSealed ? 'bg-amber-500 hover:bg-amber-600 text-black' : 'bg-white/5 text-gray-600 cursor-not-allowed pointer-events-none'
                  }`} aria-disabled={!status.configSealed}>
                  Connect QuickBooks Account →
                </a>
                {!status.configSealed && <p className="text-xs text-gray-600">Complete step 1 first.</p>}
              </div>
            )}
          </div>

          {/* Step 3: Scope grants */}
          <ScopeGrantSection
            entry={entry}
            activeSet={activeSet}
            stepNumber={3}
            grantingScope={grantingScope}
            grantError={grantError}
            tokenSealed={status.tokenSealed}
            noTokenHint="Connect your account (step 2) to enable scope grants."
            onToggle={(name, enable) => { void handleToggleScope(name, enable); }}
          />

          {status.manifestAssetId && (
            <div className="text-xs text-gray-700 font-mono truncate pt-1 border-t border-white/5" title="Scope-manifest asset ID">
              manifest: {status.manifestAssetId}
            </div>
          )}

          {/* Disconnect */}
          {(status.configSealed || status.tokenSealed) && (
            <DisconnectSection
              label="Disconnect QuickBooks"
              disconnecting={disconnecting}
              disconnectError={disconnectError}
              onDisconnect={() => { void handleDisconnect(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Native connector card (scope toggles only — no credential step) — #1397 ────────────────────

/**
 * Card for ingestionPattern === 'native' connectors (e.g. MCP / Claude Desktop).
 *
 * Native connectors need no credential — enabling one is purely toggling scopes.
 * There is no configure step and no connect step. Scope toggles are always
 * available (tokenSealed is effectively always true).
 */
function NativeConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [grantingScope, setGrantingScope] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus(await r.json() as NativeStatus);
    } catch (err: unknown) {
      setStatusError(String(err));
    } finally {
      setStatusLoading(false);
    }
  }, [entry.statusEndpoint]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const activeSet = new Set(status?.activeScopes ?? []);
  // Ready = at least one scope is active (no credential threshold for native connectors).
  const hasAnyActive = activeSet.size > 0;

  async function handleToggleScope(scopeName: string, enable: boolean) {
    setGrantingScope(scopeName);
    setGrantError(null);
    try {
      const newScopes = await postScopeToggle(entry.statusEndpoint!, status?.activeScopes ?? [], scopeName, enable);
      setStatus(prev => prev ? { ...prev, activeScopes: newScopes } : prev);
    } catch (err: unknown) {
      setGrantError(String(err));
    } finally {
      setGrantingScope(null);
    }
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{entry.icon}</span>
          <div>
            <h2 className="text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-sm text-gray-400">{entry.description}</p>
          </div>
        </div>
        <ConnectorStatusBadge loading={statusLoading} error={!!statusError} ready={hasAnyActive} />
      </div>

      {statusLoading && <p className="text-gray-500 text-sm">Loading status…</p>}
      {statusError && <p className="text-red-400 text-sm">Could not load status: {statusError}</p>}

      {!statusLoading && !statusError && status && (
        <div className="space-y-4">
          {/*
           * Native connectors skip the configure + connect steps entirely.
           * Scope toggles are always available — no credential is required.
           */}
          <ScopeGrantSection
            entry={entry}
            activeSet={activeSet}
            stepNumber={1}
            grantingScope={grantingScope}
            grantError={grantError}
            tokenSealed={true}
            noTokenHint=""
            onToggle={(name, enable) => { void handleToggleScope(name, enable); }}
          />

          {status.manifestAssetId && (
            <div className="text-xs text-gray-700 font-mono truncate pt-1 border-t border-white/5" title="Scope-manifest asset ID">
              manifest: {status.manifestAssetId}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pending connector card (no backend yet) ─────────────────────────────────────────────────────

function PendingConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
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
        <Badge variant="inactive">Coming soon</Badge>
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

    </div>
  );
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Class-aware connector detail dispatcher (#1397).
 *
 * Routing priority:
 *   1. backendPending → PendingConnectorCard (no API calls)
 *   2. ingestionPattern === 'native' → NativeConnectorCard (scope toggles only)
 *   3. Per-connector OAuth / token-paste cards (id-keyed)
 *   4. PendingConnectorCard fallback for unknown future connectors
 *
 * Adding a new native connector: set ingestionPattern: 'native' in the registry
 * — no code change needed here.
 * Adding a new OAuth/token-paste connector: add an id branch below.
 */
export function ConnectorDetail({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  if (entry.backendPending) return <PendingConnectorCard entry={entry} />;
  if (entry.ingestionPattern === 'native') return <NativeConnectorCard entry={entry} />;
  if (entry.id === 'github') return <GitHubConnectorCard entry={entry} />;
  if (entry.id === 'discord') return <DiscordConnectorCard entry={entry} />;
  if (entry.id === 'quickbooks') return <QuickBooksConnectorCard entry={entry} />;
  return <PendingConnectorCard entry={entry} />;
}
