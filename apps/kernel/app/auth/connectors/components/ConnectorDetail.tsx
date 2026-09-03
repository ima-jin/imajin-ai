'use client';

/**
 * ConnectorDetail — the per-connector configure/scope/disconnect view.
 *
 * Extracted from the old monolithic /auth/connectors page (#1494) so the
 * connectors landing can become a registry-driven grid that links into this
 * detail view at /auth/connectors/[id].
 *
 * Routing is a projection of `ingestionPattern` (#1604 — see
 * `connector-card-kind.ts`), not a per-id list:
 *   'native'                        → NativeConnectorCard (scope toggles + revoke-all)
 *   'oauth'                         → per-connector OAuth card
 *   'token-paste' | 'static-secret' → CredentialPasteConnectorCard
 * All on-consent scopes use grant-by-edit — toggling in the UI writes the
 * consent_grants row automatically.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  type ConnectorEntry,
  type ConnectorScope,
  type ConnectorSettingsUi,
  type CredentialUiCopy,
  type ReleaseClass,
} from '@/src/lib/kernel/connector-registry';
import {
  connectorCardKind,
  credentialBodyKey,
  credentialSealed,
  disconnectMethod,
  type CredentialSealedFlags,
} from '@/src/lib/kernel/connector-card-kind';
import { buildConnectHref, readConnectOutcome } from '@/src/lib/kernel/connect-outcome';

// ── Types ─────────────────────────────────────────────────────

interface GitHubStatus {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
  configSealed: boolean;
  tokenSealed: boolean;
  /** Sealed but awaiting owner grant approval (Tier 1, #1521) — not the same as "not configured". */
  credentialPending?: boolean;
  /**
   * Which BYO auth path the sealed config is for (#1391), or null when nothing
   * is sealed yet. Non-secret — the discriminator only.
   */
  flow?: GitHubAuthFlow | null;
}

/** The two BYO GitHub auth paths (#1391). Both use the owner's own OAuth App. */
type GitHubAuthFlow = 'device' | 'authorization_code';

/**
 * Status shape for paste-a-credential connectors (Discord, Gemini, Warp).
 *
 * The sealed-credential boolean arrives under a different name per connector
 * (`tokenSealed` / `keySealed` / `secretSealed`) because each backend named it
 * before it was ever read generically. `credentialSealed()` normalises them.
 */
interface CredentialPasteStatus extends CredentialSealedFlags {
  manifestAssetId: string | null;
  activeScopes: string[];
  validScopes: string[];
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
  // owner-only (#1253): behind the same consent barrier as on-consent, but it is
  // never released to a third party — only the owner can ever exercise it.
  'owner-only': 'owner only',
  never: 'never active',
};

const RELEASE_CLASS_COLOR: Record<ReleaseClass, string> = {
  silent: 'text-green-400',
  'on-consent': 'text-amber-400',
  'owner-only': 'text-amber-400',
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

/** Connect/reconnect href for a connector, carrying `returnTo` (#1529). */
function connectHref(entry: ConnectorEntry): string {
  return buildConnectHref(entry.connectRoute!, entry.id);
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

/**
 * Renders the outcome of a just-completed OAuth round-trip, read from the query
 * string the callback redirected us back with (#1529).
 *
 * The interpretation lives in `readConnectOutcome` — this component only wires
 * it to the URL and renders the result. On success it also nudges the card to
 * re-fetch status, since the credential was sealed server-side while the
 * browser was away at the provider.
 */
function ConnectOutcomeBannerInner({ connectorId, onConnected }: Readonly<{
  connectorId: string;
  onConnected: () => void;
}>) {
  const searchParams = useSearchParams();
  const { connected, errorMessage } = readConnectOutcome(searchParams, connectorId);

  useEffect(() => {
    if (connected) onConnected();
  }, [connected, onConnected]);

  if (connected) {
    return (
      <output className="block mb-4 px-4 py-3 rounded-lg bg-green-500/10 border border-green-500/30 text-sm text-green-300">
        ✅ Connected. Your credentials are sealed — grant the scopes you need below.
      </output>
    );
  }

  if (errorMessage) {
    return (
      <output className="block mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
        {errorMessage}
      </output>
    );
  }

  return null;
}

/**
 * Suspense wrapper — `useSearchParams` needs a boundary above it or the client
 * build bails out of static rendering for the whole route.
 */
function ConnectOutcomeBanner(props: Readonly<{ connectorId: string; onConnected: () => void }>) {
  return (
    <Suspense fallback={null}>
      <ConnectOutcomeBannerInner {...props} />
    </Suspense>
  );
}

/** One scope row inside a ScopeGrantSection. */
function ScopeRow({ scope, isActive, isGranting, isAnyGranting, tokenSealed, onToggle }: Readonly<{
  scope: ConnectorScope; isActive: boolean; isGranting: boolean;
  isAnyGranting: boolean; tokenSealed: boolean;
  onToggle: (name: string, enable: boolean) => void;
}>) {
  const isLocked = scope.releaseClass === 'never';
  // #1679: the credential step gates the scopes that SPEND the credential, not
  // the whole card. A read-only scope that unseals nothing stays grantable with
  // no key in place — otherwise it is structurally hostage to a credential its
  // holder may never want, which is how `discovery:read` ended up ungrantable.
  const credentialBlocked = !tokenSealed && !scope.credentialFree;
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
          disabled={isLocked || credentialBlocked || isGranting || isAnyGranting}
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
  // Only worth saying when the credential actually blocks something: on a card
  // whose scopes are all credential-free the hint would be a lie (#1679).
  const showNoTokenHint = !tokenSealed && entry.scopes.some((scope) => !scope.credentialFree);
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
      {showNoTokenHint && <p className="text-xs text-gray-600 mt-2">{noTokenHint}</p>}
    </div>
  );
}

// ── Non-secret settings section (#1632) ──────────────────────────────────────

/**
 * Editable non-secret settings for a connector, driven entirely by
 * `entry.settings` (#1632).
 *
 * The caller renders it only when `entry.settings` is non-null, so a connector
 * opts in by adding a registry entry — the alternative, an `entry.id === 'warp'`
 * branch, is the exact shape of the bug #1604 removed from this file.
 *
 * Values are read back and shown in plain `type="text"` inputs, which is the
 * whole reason this is separate from the credential step: a setting is a
 * preference the owner needs to *see* to change confidently, while a credential
 * must stay write-only.
 *
 * `onSaved` (#1969) fires after a *successful* save or clear so the parent
 * connector card can re-fetch its own status — without it, a card's model
 * picker / scope toggles that gate on a setting (e.g. the `local` connector's
 * `baseUrl`, #1957) only unlocked after a manual reload. Never called on a
 * failed save: `error` above is the only signal for that case.
 */
function ConnectorSettingsSection({ settings, stepNumber, onSaved }: Readonly<{
  settings: ConnectorSettingsUi;
  stepNumber: string | number;
  onSaved?: () => void;
}>) {
  // Draft values keyed by field key. Empty string means "no value set".
  const [values, setValues] = useState<Record<string, string>>({});
  // Server-confirmed values, so Save/Clear can tell a real edit from a no-op.
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { route, fields } = settings;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(route);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = await r.json() as Record<string, unknown>;
      const next: Record<string, string> = {};
      for (const field of fields) {
        const value = data[field.key];
        next[field.key] = typeof value === 'string' ? value : '';
      }
      setValues(next);
      setSaved(next);
      setError(null);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [route, fields]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Persist one field. An emptied input is a clear (DELETE) rather than a write
   * of the empty string, so "select all, delete, save" does what it looks like.
   */
  async function save(key: string) {
    const value = (values[key] ?? '').trim();
    setBusyKey(key);
    setError(null);
    try {
      const r = await fetch(route, {
        method: value.length === 0 ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        ...(value.length === 0 ? {} : { body: JSON.stringify({ [key]: value }) }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
      setValues((prev) => ({ ...prev, [key]: value }));
      setSaved((prev) => ({ ...prev, [key]: value }));
      onSaved?.();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const anySaved = fields.some((field) => (saved[field.key] ?? '').length > 0);

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 mb-3">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
          anySaved ? 'bg-green-500/20 text-green-400' : 'bg-white/10 text-gray-500'
        }`}>
          {anySaved ? '✓' : stepNumber}
        </span>
        {' '}Settings
      </h3>

      {loading && <p className="text-gray-500 text-xs">Loading settings…</p>}
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      {!loading && (
        <div className="space-y-4">
          {fields.map((field) => {
            const value = values[field.key] ?? '';
            const dirty = value.trim() !== (saved[field.key] ?? '');
            return (
              <div key={field.key} className="space-y-2">
                <label htmlFor={`setting-${field.key}`} className="text-sm text-gray-300 block">
                  {field.label}
                </label>
                <input
                  id={`setting-${field.key}`}
                  type="text"
                  value={value}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 font-mono"
                />
                <p className="text-xs text-gray-700">{field.hint}</p>
                <button
                  type="button"
                  onClick={() => { void save(field.key); }}
                  disabled={busyKey !== null || !dirty}
                  className="px-4 py-1.5 bg-white/10 hover:bg-white/20 disabled:opacity-40 text-gray-200 text-sm rounded-lg transition"
                >
                  {busyKey === field.key ? 'Saving…' : 'Save'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Dynamic model picker (#1769) ─────────────────────────────────────────────

/** One selectable model, as returned by a connector's `modelsRoute` GET. */
interface ModelOption {
  id: string;
  name: string;
}

/**
 * Dropdown model picker for connectors that declare `entry.modelsRoute`
 * (#1769) — currently Gemini, whose model ids Google retires/renames often
 * enough that a hardcoded default silently went stale (#1764).
 *
 * Distinct from `ConnectorSettingsSection`: the choices come from a live
 * provider call using the owner's own sealed key (`GET modelsRoute`), not a
 * static field the card already knows how to render as a text input.
 */
function ModelPickerSection({ route, stepNumber }: Readonly<{
  route: string;
  stepNumber: string | number;
}>) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(route);
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
      const data = await r.json() as { models?: ModelOption[]; currentModelId?: string | null };
      setModels(Array.isArray(data.models) ? data.models : []);
      setSelected(data.currentModelId ?? '');
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [route]);

  useEffect(() => { void load(); }, [load]);

  async function handleSelect(modelId: string) {
    setSelected(modelId);
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(route, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 mb-3">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
          selected ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
        }`}>
          {selected ? '✓' : stepNumber}
        </span>
        {' '}Model
      </h3>
      {loading && <p className="text-gray-500 text-xs">Loading models…</p>}
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      {!loading && !error && (
        <select
          value={selected}
          onChange={(e) => { void handleSelect(e.target.value); }}
          disabled={saving || models.length === 0}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50"
        >
          <option value="" disabled>Choose a model…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      )}
      {!loading && !error && models.length === 0 && (
        <p className="text-xs text-gray-600 mt-2">No models available for this key yet.</p>
      )}
    </div>
  );
}

// ── Shared disconnect hook + component ──────────────────────────────────────────────

/**
 * Encapsulates the disconnect state + handler shared by all connector cards.
 * Deduplicated from the near-identical inline copies that previously lived in
 * each card (#1490 Sonar fix).
 *
 * @param disconnectRoute  The `entry.disconnectRoute` URL, or null when the
 *                         connector has no disconnect route yet (e.g. Gemini).
 *                         Null makes the handler a no-op so the hook can still
 *                         be called unconditionally.
 * @param confirmMessage   Text shown in the browser confirm dialog.
 * @param onSuccess        Called (synchronously) after a successful disconnect;
 *                         typically `() => { void fetchStatus(); }`.
 * @param method           Verb the route expects. Static-secret connectors serve
 *                         seal and revoke from one route, so theirs is DELETE.
 */
function useDisconnect(
  disconnectRoute: string | null,
  confirmMessage: string,
  onSuccess: () => void,
  method: 'POST' | 'DELETE' = 'POST',
) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function handleDisconnect() {
    if (!disconnectRoute) return;
    if (!window.confirm(confirmMessage)) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const r = await fetch(disconnectRoute, { method });
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

// ── GitHub device flow (#1391) ──────────────────────────────────────────

/** Server response from POST /github/api/device/start. */
interface DeviceGrant {
  /** Opaque, DID-bound handle for the pending authorization. Not the device code. */
  ticket: string;
  /** Short code the human types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
}

/** Poll states mirrored from the server route (RFC 8628). */
type DevicePollStatus = 'authorized' | 'pending' | 'slow_down' | 'expired' | 'denied';

/** Where the card is in the device round-trip. */
type DeviceStage = 'idle' | 'starting' | 'awaiting' | 'connected' | 'error';

/** Extra pacing added on a `slow_down`, matching the server-side loop. */
const DEVICE_SLOW_DOWN_INCREMENT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** POST JSON and throw the server's `error` string on a non-2xx. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data;
}

/**
 * Drive a GitHub device flow from the browser (#1391).
 *
 * The poll loop lives here rather than on the server because a device code can
 * take fifteen minutes to be authorized, and a route handler that blocks that
 * long is not a request. The server exposes one quick tick
 * (`/github/api/device/poll`) and this hook paces the ticks, honouring the
 * provider-supplied `interval` and backing off on `slow_down`.
 *
 * The access token never reaches this code: an `authorized` tick means the
 * server already sealed the bundle, so all the UI does is refresh status.
 */
function useGitHubDeviceConnect(onConnected: () => void) {
  const [stage, setStage] = useState<DeviceStage>('idle');
  const [grant, setGrant] = useState<DeviceGrant | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Flipped on unmount so a loop already in flight stops setting state on a
  // card that is no longer mounted.
  const abandoned = useRef(false);
  useEffect(() => () => { abandoned.current = true; }, []);

  const pollUntilSettled = useCallback(async (ticket: string, intervalSeconds: number) => {
    let waitMs = Math.max(intervalSeconds, 1) * 1000;
    for (;;) {
      await delay(waitMs);
      if (abandoned.current) return;
      const { status } = await postJson<{ status: DevicePollStatus }>(
        '/github/api/device/poll', { ticket },
      );
      if (abandoned.current) return;
      if (status === 'authorized') {
        setGrant(null);
        setStage('connected');
        onConnected();
        return;
      }
      if (status === 'expired') {
        throw new Error('That code expired before it was authorized. Start again.');
      }
      if (status === 'denied') {
        throw new Error('Authorization was declined on GitHub.');
      }
      if (status === 'slow_down') waitMs += DEVICE_SLOW_DOWN_INCREMENT_MS;
    }
  }, [onConnected]);

  const start = useCallback(async () => {
    setStage('starting');
    setError(null);
    setGrant(null);
    try {
      const next = await postJson<DeviceGrant>('/github/api/device/start', {});
      if (abandoned.current) return;
      setGrant(next);
      setStage('awaiting');
      await pollUntilSettled(next.ticket, next.interval);
    } catch (err: unknown) {
      if (abandoned.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [pollUntilSettled]);

  return { stage, grant, error, start };
}

/**
 * Step 2 for device mode: the button that starts the flow, then the user code
 * the human types at github.com/login/device while the card polls.
 */
function GitHubDeviceConnect({ configSealed, onConnected }: Readonly<{
  configSealed: boolean;
  onConnected: () => void;
}>) {
  const { stage, grant, error, start } = useGitHubDeviceConnect(onConnected);
  const busy = stage === 'starting' || stage === 'awaiting';

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => { void start(); }}
        disabled={!configSealed || busy}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition bg-amber-500 hover:bg-amber-600 text-black disabled:bg-white/5 disabled:text-gray-600 disabled:cursor-not-allowed"
      >
        {stage === 'starting' && 'Requesting code…'}
        {stage === 'awaiting' && 'Waiting for authorization…'}
        {stage !== 'starting' && stage !== 'awaiting' && 'Connect with device flow →'}
      </button>

      {!configSealed && <p className="text-xs text-gray-600">Complete step 1 first.</p>}

      {grant && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <p className="text-xs text-gray-400">Enter this code at GitHub:</p>
          <p className="text-2xl font-mono tracking-[0.3em] text-white" data-testid="device-user-code">
            {grant.userCode}
          </p>
          <a
            href={grant.verificationUriComplete ?? grant.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-amber-400 hover:text-amber-300 underline break-all"
          >
            {grant.verificationUri}
          </a>
          <p className="text-xs text-gray-600">
            Leave this page open — it finishes on its own once you approve.
          </p>
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

/**
 * Step-1 mode picker: which BYO auth path to configure (#1391).
 *
 * Both options are bring-your-own OAuth App — the choice is only about how the
 * owner's app authorizes, never about whose credential is used. Device is
 * marked recommended because it drops the client secret and the byte-exact
 * callback URL, the two things that make the manual path fail on first try.
 */
function GitHubFlowSelector({ value, onChange }: Readonly<{
  value: GitHubAuthFlow;
  onChange: (next: GitHubAuthFlow) => void;
}>) {
  const options: ReadonlyArray<{ flow: GitHubAuthFlow; title: string; hint: string }> = [
    {
      flow: 'device',
      title: 'Device flow (recommended)',
      hint: 'Client ID only — no client secret, no callback URL. Requires “Enable Device Flow” in your OAuth App.',
    },
    {
      flow: 'authorization_code',
      title: 'Manual (client ID + secret + callback)',
      hint: 'Browser redirect to your registered callback URL.',
    },
  ];

  return (
    <fieldset className="space-y-2 pb-1">
      <legend className="text-xs text-gray-500 mb-1">Auth mode</legend>
      {options.map((option) => (
        <label
          key={option.flow}
          className={`flex gap-3 items-start px-3 py-2 rounded-lg border cursor-pointer transition ${
            value === option.flow
              ? 'border-amber-500/50 bg-amber-500/5'
              : 'border-white/10 hover:border-white/20'
          }`}
        >
          <input
            type="radio"
            name="github-auth-flow"
            value={option.flow}
            checked={value === option.flow}
            onChange={() => onChange(option.flow)}
            className="mt-1 accent-amber-500"
          />
          <span className="min-w-0">
            <span className="text-sm text-white block">{option.title}</span>
            <span className="text-xs text-gray-600 block">{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Step 2 of the GitHub card: whichever connect affordance the configured flow
 * calls for. Device mode polls in place; authorization-code mode leaves for the
 * provider and comes back through /github/api/callback.
 */
function GitHubConnectStep({ entry, flowMode, configSealed, tokenSealed, onConnected }: Readonly<{
  entry: ConnectorEntry;
  flowMode: GitHubAuthFlow;
  configSealed: boolean;
  tokenSealed: boolean;
  onConnected: () => void;
}>) {
  if (tokenSealed) {
    return (
      <div className="flex items-center justify-between text-sm">
        <StatusDot ok={true} label="Account connected" />
        {flowMode === 'device' ? (
          <GitHubDeviceReconnect onConnected={onConnected} />
        ) : (
          <a
            href={connectHref(entry)}
            className="text-xs text-gray-600 hover:text-gray-400 transition"
          >
            Reconnect
          </a>
        )}
      </div>
    );
  }

  if (flowMode === 'device') {
    return <GitHubDeviceConnect configSealed={configSealed} onConnected={onConnected} />;
  }

  return (
    <div className="space-y-2">
      <a
        href={connectHref(entry)}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
          configSealed
            ? 'bg-amber-500 hover:bg-amber-600 text-black'
            : 'bg-white/5 text-gray-600 cursor-not-allowed pointer-events-none'
        }`}
        aria-disabled={!configSealed}
      >
        Connect GitHub Account →
      </a>
      {!configSealed && <p className="text-xs text-gray-600">Complete step 1 first.</p>}
    </div>
  );
}

/**
 * Reconnect affordance for an already-connected device-flow account. Same hook
 * as the first connect — re-authorizing simply re-seals the bundle.
 */
function GitHubDeviceReconnect({ onConnected }: Readonly<{ onConnected: () => void }>) {
  const { stage, grant, error, start } = useGitHubDeviceConnect(onConnected);
  const busy = stage === 'starting' || stage === 'awaiting';

  return (
    <span className="flex items-center gap-2 text-xs">
      {grant && <span className="font-mono text-amber-400">{grant.userCode}</span>}
      {error && <span className="text-red-400">{error}</span>}
      <button
        type="button"
        onClick={() => { void start(); }}
        disabled={busy}
        className="text-xs text-gray-600 hover:text-gray-400 transition disabled:opacity-50"
      >
        {busy ? 'Waiting…' : 'Reconnect'}
      </button>
    </span>
  );
}

// ── GitHub card (interactive: configure → connect → grant) — #1352 ─────────

function GitHubConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Configure form state
  const [showConfigure, setShowConfigure] = useState(false);
  // Device flow is the default (#1391): it is the BYO path that needs neither a
  // client secret nor a byte-exact callback URL, which are the two steps that
  // actually trip people up.
  const [flowMode, setFlowMode] = useState<GitHubAuthFlow>('device');
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

  // Adopt the flow the owner already sealed, so a returning auth-code user is
  // not shown the device selector as though they had chosen it.
  const sealedFlow = status?.flow ?? null;
  useEffect(() => {
    if (sealedFlow) setFlowMode(sealedFlow);
  }, [sealedFlow]);

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

  // ── Step 1: Configure OAuth App ───────────────────────────────────────

  /**
   * Device mode posts `clientId` and nothing else — the route rejects a secret
   * or redirect URI in that mode rather than sealing credentials the flow will
   * never use (#1391).
   */
  function configureBody(): Record<string, string> {
    if (flowMode === 'device') {
      return { flow: 'device', clientId: clientId.trim() };
    }
    return {
      flow: 'authorization_code',
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      redirectUri: redirectUri.trim(),
    };
  }

  /** Whether the step-1 form has everything the selected mode requires. */
  function configureReady(): boolean {
    if (!clientId.trim()) return false;
    return flowMode === 'device' || Boolean(clientSecret.trim() && redirectUri.trim());
  }

  async function handleConfigure(e: React.FormEvent) {
    e.preventDefault();
    setConfiguring(true);
    setConfigError(null);
    try {
      const r = await fetch('/github/api/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configureBody()),
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

      <ConnectOutcomeBanner connectorId={entry.id} onConnected={refreshStatus} />

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
                <GitHubFlowSelector value={flowMode} onChange={setFlowMode} />
                <input
                  ref={clientIdRef}
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="OAuth App Client ID"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
                />
                {flowMode === 'authorization_code' && (
                  <>
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
                  </>
                )}
                {configError && <p className="text-red-400 text-xs">{configError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={configuring || !configureReady()}
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
                <StatusDot
                  ok={true}
                  label={
                    flowMode === 'device'
                      ? 'OAuth App config sealed (device flow)'
                      : 'OAuth App config sealed'
                  }
                />
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

            <GitHubConnectStep
              entry={entry}
              flowMode={flowMode}
              configSealed={status.configSealed}
              tokenSealed={status.tokenSealed}
              onConnected={refreshStatus}
            />
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

// ── Credential-paste card (token-paste + static-secret) — #1604 ──────────────

/**
 * Copy fallback for a paste-style connector whose registry entry omits
 * `credentialUi`. The dispatch guard test requires every paste-style entry to
 * declare it, so this only keeps the component total — it is not a licence to
 * skip the registry copy.
 */
function credentialCopy(entry: ConnectorEntry): CredentialUiCopy {
  return entry.credentialUi ?? {
    label: 'Credential',
    placeholder: `${entry.name} credential`,
    hint: 'Sealed server-side and never returned.',
  };
}

/**
 * Confirm text for disconnecting a paste-style connector.
 *
 * Every paste-style connector's disconnect revokes the sealed credential's
 * delegation grant, which crypto-erases the wrapped field key and cuts off
 * access immediately. Some (e.g. Discord) also tombstone the underlying vault
 * entry as part of the same request; others (e.g. Gemini, Anthropic, GCP,
 * Warp — #1720) deliberately leave the sealed ciphertext in place so the owner
 * can restore access by re-granting without re-pasting the credential. The
 * dialog only promises what is true for every one of them: access is revoked.
 */
function disconnectConfirmMessage(entry: ConnectorEntry, credentialLabel: string): string {
  return `Disconnect ${entry.name}? This revokes access to the sealed ${credentialLabel} immediately.`;
}

/**
 * Card for connectors whose credential is pasted in-app rather than collected
 * through an OAuth redirect: `ingestionPattern` of `'token-paste'` (Discord,
 * Gemini) or `'static-secret'` (Warp).
 *
 * Generalised from the old `DiscordConnectorCard`, which was reachable only via
 * an `entry.id === 'discord'` dispatcher branch — the omission that left Gemini
 * (#1432) and Warp (#1428) rendering "Coming soon" against live backends. Every
 * per-connector difference is now read from the registry entry:
 *   - copy            → `entry.credentialUi`
 *   - seal route      → `entry.tokenRoute`, body key from `credentialBodyKey`
 *   - disconnect      → `entry.disconnectRoute` + verb from `disconnectMethod`;
 *                       hidden entirely when the connector has no such route
 *   - sealed boolean  → normalised by `credentialSealed`
 */
function CredentialPasteConnectorCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [status, setStatus] = useState<CredentialPasteStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Credential paste state
  const [credentialInput, setCredentialInput] = useState('');
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [showCredentialInput, setShowCredentialInput] = useState(false);

  // Scope grant state
  const [grantingScope, setGrantingScope] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const ui = credentialCopy(entry);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus(await r.json() as CredentialPasteStatus);
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
      setStatus(await r.json() as CredentialPasteStatus);
      setStatusError(null);
    } catch { /* non-fatal */ }
  }, [entry.statusEndpoint]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const { disconnecting, disconnectError, handleDisconnect } = useDisconnect(
    entry.disconnectRoute,
    disconnectConfirmMessage(entry, ui.label),
    () => { void fetchStatus(); },
    disconnectMethod(entry),
  );

  const activeSet = new Set(status?.activeScopes ?? []);
  const sealed = status !== null && credentialSealed(status);
  // Connected = a sealed credential plus at least one active scope. The old
  // Discord card hardcoded `discord:post`, which reported "Not configured" for a
  // deliberate read-only grant; any active scope means the connector can act.
  const ready = sealed && activeSet.size > 0;

  async function handleSealCredential(e: React.FormEvent) {
    e.preventDefault();
    setSealing(true);
    setSealError(null);
    try {
      const r = await fetch(entry.tokenRoute!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [credentialBodyKey(entry)]: credentialInput.trim() }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `${r.status} ${r.statusText}`);
      }
      setCredentialInput('');
      setShowCredentialInput(false);
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
          ready={ready}
          pending={status?.credentialPending}
        />
      </div>

      {statusLoading && <p className="text-gray-500 text-sm">Loading status…</p>}
      {statusError && <p className="text-red-400 text-sm">Could not load status: {statusError}</p>}

      {!statusLoading && !statusError && status && (
        <div className="space-y-6">

          {/* ── Step 1: the credential ── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                  sealed ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
                }`}>
                  {sealed ? '✓' : '1'}
                </span>
                {' '}{ui.label}
              </h3>
              {sealed && !showCredentialInput && (
                <button type="button"
                  onClick={() => setShowCredentialInput(true)}
                  className="text-xs text-gray-600 hover:text-gray-400 transition"
                >
                  Replace
                </button>
              )}
            </div>

            {!sealed || showCredentialInput ? (
              <form onSubmit={(e) => { void handleSealCredential(e); }} className="space-y-2">
                <input
                  type="password"
                  value={credentialInput}
                  onChange={(e) => setCredentialInput(e.target.value)}
                  placeholder={ui.placeholder}
                  required
                  autoComplete="off"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 font-mono"
                />
                <p className="text-xs text-gray-700">{ui.hint}</p>
                {sealError && <p className="text-red-400 text-xs">{sealError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={sealing || !credentialInput.trim()}
                    className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-sm font-medium rounded-lg transition"
                  >
                    {sealing ? 'Sealing…' : `${sealed ? 'Replace' : 'Seal'} ${ui.label}`}
                  </button>
                  {showCredentialInput && (
                    <button type="button" onClick={() => { setShowCredentialInput(false); setSealError(null); }}
                      className="px-4 py-1.5 bg-white/5 hover:bg-white/10 text-gray-400 text-sm rounded-lg transition">
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <StatusDot ok={true} label={`${ui.label} sealed`} />
            )}
          </div>

          {/*
            ── Step 2 (optional): non-secret settings ──
            Present only for connectors that declare `settings` (#1632), which
            shifts scope grants to step 3 for those and leaves it at 2 otherwise.
          */}
          {entry.settings && (
            <ConnectorSettingsSection settings={entry.settings} stepNumber={2} onSaved={refreshStatus} />
          )}

          {/*
            ── Step (optional): model picker (#1769) ──
            Only once the credential is sealed — the route needs the owner's
            own key to ask the provider which models it can use.
          */}
          {entry.modelsRoute && sealed && (
            <ModelPickerSection
              route={entry.modelsRoute}
              stepNumber={entry.settings ? 3 : 2}
            />
          )}

          {/* ── Scope grants ── */}
          <ScopeGrantSection
            entry={entry}
            activeSet={activeSet}
            stepNumber={(entry.settings ? 1 : 0) + (entry.modelsRoute && sealed ? 1 : 0) + 2}
            grantingScope={grantingScope}
            grantError={grantError}
            tokenSealed={sealed}
            noTokenHint={`Seal your ${ui.label} (step 1) to enable scope grants.`}
            onToggle={(name, enable) => { void handleToggleScope(name, enable); }}
          />

          {status.manifestAssetId && (
            <div className="text-xs text-gray-700 font-mono truncate pt-1 border-t border-white/5" title="Scope-manifest asset ID">
              manifest: {status.manifestAssetId}
            </div>
          )}

          {/* Disconnect — only for connectors that expose a disconnect route. */}
          {sealed && entry.disconnectRoute && (
            <DisconnectSection
              label={`Disconnect ${entry.name}`}
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

      <ConnectOutcomeBanner connectorId={entry.id} onConnected={refreshStatus} />

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
                <a href={connectHref(entry)} className="text-xs text-gray-600 hover:text-gray-400 transition">Reconnect</a>
              </div>
            ) : (
              <div className="space-y-2">
                <a href={connectHref(entry)}
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

// ── Native connector card (scope toggles + revoke-all — no credential step) — #1397, #1592 ─────

/**
 * Card for ingestionPattern === 'native' connectors (e.g. MCP / Claude Desktop).
 *
 * Native connectors need no credential — enabling one is purely toggling scopes.
 * There is no configure step and no connect step. Scope toggles are always
 * available (tokenSealed is effectively always true).
 *
 * Because the toggles are the whole connection, they were also the only way off
 * it until #1592: withdrawing a native connector meant clicking every scope off
 * one at a time. The disconnect button below is the single-action equivalent —
 * it posts to a route that republishes the manifest empty, so it revokes through
 * the same rail the toggles grant through.
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

  // Background refresh — does not blank the card, so the just-cleared toggles
  // stay on screen while the manifest id catches up.
  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(entry.statusEndpoint!);
      if (!r.ok) return;
      setStatus(await r.json() as NativeStatus);
      setStatusError(null);
    } catch { /* non-fatal */ }
  }, [entry.statusEndpoint]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  /**
   * Clear the toggles from the disconnect response rather than re-fetching into
   * a blanked card. The route verifies the revoke landed before it reports
   * success — a 500 comes back instead if anything is still active — so an empty
   * `activeScopes` here is server-confirmed, not optimistic.
   */
  const { disconnecting, disconnectError, handleDisconnect } = useDisconnect(
    entry.disconnectRoute,
    `Disconnect ${entry.name}? This revokes every scope you have granted it. `
    + 'Any connected client loses access immediately; nothing is deleted, and you can grant scopes again at any time.',
    () => {
      setStatus((prev) => (prev ? { ...prev, activeScopes: [] } : prev));
      setGrantError(null);
      void refreshStatus();
    },
    disconnectMethod(entry),
  );

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

          {/*
            Revoke-all (#1592) — shown only when there is something to revoke, and
            only when the connector declares the route. Offering it with no active
            grant would be a button whose whole effect is an error message.
          */}
          {hasAnyActive && entry.disconnectRoute && (
            <DisconnectSection
              label={`Disconnect ${entry.name}`}
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
 * Per-id OAuth cards, pending their consolidation into one `OAuthConnectorCard`
 * (the explicit fast-follow to #1604). This is the last id-keyed dispatch in the
 * file; `connector-card-dispatch.test.ts` pins the ids so a new OAuth connector
 * fails a test here instead of silently rendering "Coming soon".
 */
const OAUTH_CARDS: Record<string, (props: Readonly<{ entry: ConnectorEntry }>) => React.ReactElement> = {
  github: GitHubConnectorCard,
  quickbooks: QuickBooksConnectorCard,
};

/**
 * Pattern-aware connector detail dispatcher (#1397, routed by ingestion pattern
 * in #1604).
 *
 * Adding a connector whose `ingestionPattern` already has a card — native or
 * credential-paste — needs no change here: a registry entry is the whole job.
 * A brand-new ingestion pattern is a typecheck failure in `connectorCardKind`,
 * which is the point: it can no longer fall through to "Coming soon" unnoticed.
 */
export function ConnectorDetail({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  switch (connectorCardKind(entry)) {
    case 'pending':
      return <PendingConnectorCard entry={entry} />;
    case 'native':
      return <NativeConnectorCard entry={entry} />;
    case 'credential-paste':
      return <CredentialPasteConnectorCard entry={entry} />;
    case 'oauth': {
      const OAuthCard = OAUTH_CARDS[entry.id];
      return OAuthCard ? <OAuthCard entry={entry} /> : <PendingConnectorCard entry={entry} />;
    }
  }
}
