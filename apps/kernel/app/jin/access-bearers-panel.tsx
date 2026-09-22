'use client';

/**
 * Delegate-grant bearer section on `/jin` (#2252) — self-service for the
 * signed-in human: knock (request a scoped outbound bearer for a
 * static-header client like Muse Code), and manage the bearers already
 * issued to them.
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
  scopesText: string;
  surface: (typeof SUPPORTED_SURFACES)[number];
  slidingWindowDays: (typeof SLIDING_WINDOW_OPTIONS)[number];
}

const INITIAL_FORM: KnockFormState = {
  clientLabel: '',
  purpose: '',
  scopesText: '',
  surface: 'mcp',
  slidingWindowDays: 90,
};

function KnockForm({
  onKnock,
  busy,
}: Readonly<{ onKnock: (form: KnockFormState) => Promise<void>; busy: boolean }>) {
  const [form, setForm] = useState<KnockFormState>(INITIAL_FORM);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onKnock(form);
    setForm(INITIAL_FORM);
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-gray-800 p-3">
      <input
        type="text"
        placeholder="Client label (e.g. Muse Code)"
        value={form.clientLabel}
        onChange={(e) => setForm({ ...form, clientLabel: e.target.value })}
        className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        required
      />
      <input
        type="text"
        placeholder="Purpose (e.g. read my media library)"
        value={form.purpose}
        onChange={(e) => setForm({ ...form, purpose: e.target.value })}
        className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        required
      />
      <input
        type="text"
        placeholder="Scopes, comma-separated (e.g. discovery:read, corpus:read)"
        value={form.scopesText}
        onChange={(e) => setForm({ ...form, scopesText: e.target.value })}
        className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        required
      />
      <div className="flex items-center gap-3">
        <select
          value={form.surface}
          onChange={(e) => setForm({ ...form, surface: e.target.value as KnockFormState['surface'] })}
          className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        >
          {SUPPORTED_SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={form.slidingWindowDays}
          onChange={(e) => setForm({ ...form, slidingWindowDays: Number(e.target.value) as KnockFormState['slidingWindowDays'] })}
          className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        >
          {SLIDING_WINDOW_OPTIONS.map((d) => <option key={d} value={d}>{d}d idle window</option>)}
        </select>
      </div>
      <button type="submit" disabled={busy} className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40">
        Knock
      </button>
    </form>
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
  const [flash, setFlash] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const notify = useCallback((type: 'ok' | 'err', msg: string) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 5000);
  }, []);

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

  const handleKnock = useCallback(async (form: KnockFormState) => {
    setBusy(true);
    try {
      const scopes = form.scopesText.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetch('/auth/api/access/knock', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientLabel: form.clientLabel,
          purpose: form.purpose,
          scopes,
          surfaces: [form.surface],
          slidingWindowDays: form.slidingWindowDays,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Knock failed (${res.status})`);
        return;
      }
      notify('ok', 'Knock sent — approve it below (Operator approvals) to mint the bearer.');
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
          <p className="text-xs text-gray-500">Scoped, revocable bearer credentials for static-header clients (e.g. Muse Code) that can&apos;t do OAuth.</p>
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

      {renderBearersList(loading, bearers, handleRevoke, busyId)}
    </section>
  );
}
