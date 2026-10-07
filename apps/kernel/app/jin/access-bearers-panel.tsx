'use client';

/**
 * Delegate-grant bearer section on `/jin` (#2252, owner-initiated knock UI
 * #2367) — self-service for the signed-in human: "Issue a static bearer"
 * (knock for a scoped outbound bearer for a static-header client like Muse
 * Code, no curl), and manage the bearers already issued to them.
 *
 * Scope: this is ONLY for clients that cannot hold an Imajin keypair. An
 * agent with its own app DID should use `app.authorized` attestations
 * instead (#1883/#1900) — the form says so in plain copy.
 *
 * No-reveal-after posture (mirrors `VaultKeysPanel`): this panel never holds
 * a bearer secret. The plaintext is returned exactly once, to the operator
 * who approves the card in `OperatorApprovalsPanel`'s reveal banner; the
 * list below only ever shows metadata.
 *
 * Unlike `VaultKeysPanel`/`OperatorApprovalsPanel`, this panel is NOT
 * operator-gated — every signed-in identity may knock for and manage their
 * OWN bearers (`POST /auth/api/access/knock` always resolves `principalDid`
 * to the caller's own session identity). The actual mint happens only after
 * the node OPERATOR approves the resulting card on the operator-approvals
 * rail rendered just below this panel — see `operator-approvals-panel.tsx`'s
 * `access` renderer and its one-time bearer reveal box.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { scopeEntry, scopesForSurface, uiLabelForScope } from '@imajin/auth/scope-vocabulary';
import { useFlashNotice } from './use-flash-notice';
import { approvalCardAnchorId, requestApprovalsRefresh } from './approval-anchor';

interface DelegateGrantBearerSummary {
  bearerId: string;
  clientLabel: string;
  purpose: string;
  scopes: string[];
  surfaces: string[];
  status: string;
  issuedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  hardCapAt: string;
}

const POLL_INTERVAL_MS = 10000;
const SLIDING_WINDOW_OPTIONS = [30, 90, 180, 365] as const;
/** Only 'mcp' is enforced end-to-end today — see delegate-grant.ts's module docs. */
const SUPPORTED_SURFACES = ['mcp'] as const;
type SupportedSurface = (typeof SUPPORTED_SURFACES)[number];

interface ScopeOption {
  scope: string;
  label: string;
}

function scopeLabel(scope: string): string {
  const entry = scopeEntry(scope);
  if (!entry) return scope;
  return entry.connector ? uiLabelForScope(entry) : entry.label;
}

/** The connector scope vocabulary a static MCP bearer can carry — the same list `validateDelegateGrantKnockInput` accepts. */
const SCOPE_OPTIONS: readonly ScopeOption[] = scopesForSurface('mcp').map((scope) => ({ scope, label: scopeLabel(scope) }));

function statusBadge(status: string) {
  const cls = status === 'active' ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-500';
  return <span className={`px-1.5 py-0.5 rounded text-xs ${cls}`}>{status}</span>;
}

function BearerCard({
  bearer,
  onRevoke,
  busy,
}: Readonly<{ bearer: DelegateGrantBearerSummary; onRevoke: (bearerId: string) => void; busy: boolean }>) {
  return (
    <div className="rounded-lg border border-gray-800 p-4 space-y-2" data-testid="access-bearer-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-100">{bearer.clientLabel}</span>
          {statusBadge(bearer.status)}
        </div>
        <span className="text-xs text-gray-500">issued {new Date(bearer.issuedAt).toLocaleString()}</span>
      </div>
      <p className="text-xs text-gray-500">{bearer.purpose}</p>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Scopes</span>
        <span className="font-mono text-gray-400">{bearer.scopes.join(', ') || '—'}</span>
      </div>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Surfaces</span>
        <span className="font-mono text-gray-400">{bearer.surfaces.join(', ') || '—'}</span>
      </div>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Last used</span>
        {bearer.lastUsedAt ? new Date(bearer.lastUsedAt).toLocaleString() : 'never'}
      </div>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Expires</span>
        {new Date(bearer.expiresAt).toLocaleString()}
        <span className="mx-1">·</span>
        <span className="uppercase tracking-wide mr-2">Hard cap</span>
        {new Date(bearer.hardCapAt).toLocaleString()}
      </div>
      {bearer.status === 'active' && (
        <button
          type="button"
          onClick={() => onRevoke(bearer.bearerId)}
          disabled={busy}
          className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40"
        >
          {busy ? '…' : 'Revoke'}
        </button>
      )}
    </div>
  );
}

interface KnockFormState {
  clientLabel: string;
  purpose: string;
  scopes: string[];
  surfaces: SupportedSurface[];
  slidingWindowDays: (typeof SLIDING_WINDOW_OPTIONS)[number];
}

/** Least privilege by default: no scope is pre-selected, `mcp` is the only enforced surface. */
const INITIAL_FORM: KnockFormState = {
  clientLabel: '',
  purpose: '',
  scopes: [],
  surfaces: ['mcp'],
  slidingWindowDays: 90,
};

/** Add `value` to `list` when `checked`, drop it otherwise — never duplicates. */
function toggleIn<T>(list: readonly T[], value: T, checked: boolean): T[] {
  const without = list.filter((item) => item !== value);
  return checked ? [...without, value] : without;
}

const INPUT_CLASS = 'w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200';

function KeypairScopeNote() {
  return (
    <p className="text-xs text-gray-400 rounded border border-gray-800 bg-gray-900/40 px-3 py-2" data-testid="static-bearer-scope-note">
      A static bearer is for clients that <span className="font-medium text-gray-200">cannot hold an Imajin keypair</span> — a
      custom connector, Muse Code, or a curl script that can only send a fixed header. An agent that has its own app DID
      should use <span className="font-mono text-gray-300">app.authorized</span> attestations instead. Nothing is issued until
      the node operator approves the request in Operator approvals; the bearer is then shown once, never again.
    </p>
  );
}

function KnockForm({
  onKnock,
  busy,
}: Readonly<{ onKnock: (form: KnockFormState) => Promise<boolean>; busy: boolean }>) {
  const [form, setForm] = useState<KnockFormState>(INITIAL_FORM);
  const canSubmit = form.scopes.length > 0 && form.surfaces.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // Keep what the owner typed on failure so they can fix and resubmit.
    if (await onKnock(form)) setForm(INITIAL_FORM);
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-gray-800 p-3" aria-label="Issue a static bearer">
      <h3 className="text-sm font-medium text-gray-100">Issue a static bearer</h3>
      <KeypairScopeNote />
      <input
        type="text"
        aria-label="Client label"
        placeholder="Client label (e.g. Muse Code)"
        value={form.clientLabel}
        onChange={(e) => setForm({ ...form, clientLabel: e.target.value })}
        className={INPUT_CLASS}
        maxLength={200}
        required
      />
      <input
        type="text"
        aria-label="Purpose"
        placeholder="Purpose (e.g. read my media library)"
        value={form.purpose}
        onChange={(e) => setForm({ ...form, purpose: e.target.value })}
        className={INPUT_CLASS}
        maxLength={500}
        required
      />
      <fieldset className="space-y-1">
        <legend className="text-xs text-gray-400">Scopes — grant only what this client needs</legend>
        {SCOPE_OPTIONS.map(({ scope, label }) => (
          <label key={scope} className="flex items-start gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={form.scopes.includes(scope)}
              onChange={(e) => setForm({ ...form, scopes: toggleIn(form.scopes, scope, e.target.checked) })}
              className="accent-amber-500 mt-0.5"
            />
            <span>
              <span className="font-mono text-gray-300">{scope}</span>
              <span className="ml-2">{label}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs text-gray-400">Surfaces</legend>
        {SUPPORTED_SURFACES.map((surface) => (
          <label key={surface} className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={form.surfaces.includes(surface)}
              onChange={(e) => setForm({ ...form, surfaces: toggleIn(form.surfaces, surface, e.target.checked) })}
              className="accent-amber-500"
            />
            <span className="font-mono text-gray-300">{surface}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-xs text-gray-400">
        <span>Sliding window</span>
        <select
          value={form.slidingWindowDays}
          onChange={(e) => setForm({ ...form, slidingWindowDays: Number(e.target.value) as KnockFormState['slidingWindowDays'] })}
          className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        >
          {SLIDING_WINDOW_OPTIONS.map((d) => <option key={d} value={d}>{d}d idle window</option>)}
        </select>
      </label>
      <button
        type="submit"
        disabled={busy || !canSubmit}
        className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40"
      >
        Request bearer
      </button>
    </form>
  );
}

/** Hand-off to the approval card the knock just staged (same `#anchor` pattern as the provision-app form). */
function KnockHandoff({ proposalId, onDismiss }: Readonly<{ proposalId: string; onDismiss: () => void }>) {
  return (
    <div className="mb-3 rounded-lg border border-gray-800 p-3 space-y-1" data-testid="knock-handoff" aria-live="polite">
      <p className="text-xs font-medium text-green-300">Request sent — waiting for operator approval.</p>
      <p className="text-xs text-gray-500">
        proposalId <span className="font-mono text-gray-300" data-testid="knock-proposal-id">{proposalId}</span>
        {' — '}
        <a href={`#${approvalCardAnchorId(proposalId)}`} className="text-amber-400 hover:underline">
          review it in Operator approvals below
        </a>
      </p>
      <p className="text-xs text-gray-500">
        Approving mints the bearer and reveals it once in that panel. It is never shown again — if it is lost, revoke it
        here and issue a new one.
      </p>
      <button type="button" onClick={onDismiss} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        dismiss
      </button>
    </div>
  );
}

function renderBearersList(loading: boolean, bearers: DelegateGrantBearerSummary[], onRevoke: (id: string) => void, busyId: string): ReactNode {
  if (loading) {
    return <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>;
  }
  if (bearers.length === 0) {
    return (
      <div className="text-center py-10 rounded-lg border border-gray-800">
        <p className="text-gray-500 text-sm">No delegate-grant bearers yet.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {bearers.map((bearer) => (
        <BearerCard key={bearer.bearerId} bearer={bearer} onRevoke={onRevoke} busy={busyId === bearer.bearerId} />
      ))}
    </div>
  );
}

export function AccessBearersPanel() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bearers, setBearers] = useState<DelegateGrantBearerSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [handoffProposalId, setHandoffProposalId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { flash, notify } = useFlashNotice(5000);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/auth/api/access/bearers', { credentials: 'include' });
      if (!res.ok) {
        setVisible(false);
        return;
      }
      const data = (await res.json()) as { bearers: DelegateGrantBearerSummary[] };
      setVisible(true);
      setBearers(data.bearers ?? []);
    } catch {
      setVisible(false);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const handleKnock = useCallback(async (form: KnockFormState): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch('/auth/api/access/knock', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientLabel: form.clientLabel.trim(),
          purpose: form.purpose.trim(),
          scopes: form.scopes,
          surfaces: form.surfaces,
          slidingWindowDays: form.slidingWindowDays,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Knock failed (${res.status})`);
        return false;
      }
      const body = await res.json().catch(() => ({})) as { proposalId?: string };
      setHandoffProposalId(body.proposalId ?? null);
      // Re-fetch the approvals queue now so the card exists for the hand-off link.
      requestApprovalsRefresh();
      notify('ok', 'Request sent — approve it below (Operator approvals) to mint the bearer.');
      return true;
    } catch {
      notify('err', 'Network error — the request was not sent');
      return false;
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const handleRevoke = useCallback(async (bearerId: string) => {
    setBusyId(bearerId);
    try {
      const res = await fetch(`/auth/api/access/bearers/${encodeURIComponent(bearerId)}/revoke`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Revoke failed (${res.status})`);
        return;
      }
      notify('ok', 'Bearer revoked — immediate effect.');
      await load(true);
    } finally {
      setBusyId('');
    }
  }, [load, notify]);

  if (!visible) return null;

  return (
    <section className="mt-8" data-testid="access-bearers-panel">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Delegate-grant bearers</h2>
          <p className="text-xs text-gray-500">Scoped, revocable bearer credentials for static-header clients (e.g. Muse Code) that can&apos;t do OAuth or hold an Imajin keypair.</p>
        </div>
        <button type="button" onClick={() => load()} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
          ↺ refresh
        </button>
      </div>

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded text-xs font-medium ${flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
          {flash.msg}
        </div>
      )}

      <div className="mb-3">
        <KnockForm onKnock={handleKnock} busy={busy} />
      </div>

      {handoffProposalId && (
        <KnockHandoff proposalId={handoffProposalId} onDismiss={() => setHandoffProposalId(null)} />
      )}

      {renderBearersList(loading, bearers, handleRevoke, busyId)}
    </section>
  );
}
