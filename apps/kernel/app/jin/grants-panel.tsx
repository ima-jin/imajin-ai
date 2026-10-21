'use client';

/**
 * Grants lane panel on `/jin` (#2292) — one read projection of every grant
 * this operator has standing over, normalized across sources: agent grants
 * (#1882), the coarse legacy `identity_members` bootstrap, vault delegation
 * grants (#2247/#2235, with deferred-ack state), delegate-grant bearers
 * (#2252), and MCP/OAuth app authorizations (#1803).
 *
 * Operator sources retain the operator gate; org owner/admin act-as can
 * manage only the org's auth grants (#2997). The initial-load
 * state holds that same "nothing" so nobody briefly sees panel chrome
 * before the check resolves. Poll + silent-refresh mirrors
 * `usage-feed-panel.tsx`.
 *
 * One-tap revoke posts DIRECTLY to each card's own existing revoke/DELETE
 * route (`card.revoke.method`/`card.revoke.path`/`card.revoke.body`, as
 * returned by `GET /jin/api/grants` — see `src/lib/jin/grants-lane.ts` for
 * the full source→route mapping) — this panel never calls a new mutation
 * endpoint of its own. A revoked card becomes a tombstone: it stays in the
 * record but is filtered out by default (mirrors VaultKeysPanel's
 * "hand-provisioned" filter convention), surfaced again via the "show
 * revoked" toggle.
 *
 * Add-capability is deliberately NOT rebuilt here (#2108's control already
 * lives on `/auth/agents`) — this panel only links to it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFlashNotice } from './use-flash-notice';
import Link from 'next/link';
import type { GrantCard, GrantSourceKind, DeferredAckState, GrantAckEvidence } from '@/src/lib/jin/grants-lane';
import styles from './grants-panel.module.css';
import { forEachSequential } from '@/src/lib/async/sequential';

const defaultTransport: typeof fetch = (...args) => fetch(...args);

function surplusIds(card: GrantCard): string[] {
  if (card.source !== 'app-authorization' || card.status !== 'active' || !card.appDid || !card.revocable) return [];
  const survivor = card.id.replace(/^app-authorization:/, '');
  return [...new Set(card.surplusGrantIds ?? [])].filter(id => id && id !== survivor);
}

const POLL_INTERVAL_MS = 10000;

const SOURCE_LABELS: Record<GrantSourceKind, string> = {
  'auth-grant': 'Agent grant',
  'auth-membership': 'Legacy membership',
  'vault-delegation': 'Vault delegation',
  'access-bearer': 'Delegate-grant bearer',
  'app-authorization': 'MCP / OAuth app',
};

const ACK_STATE_STYLES: Record<DeferredAckState, string> = {
  used: 'bg-green-900/50 text-green-300',
  failed: 'bg-red-900/50 text-red-400',
  discarded: 'bg-gray-800 text-gray-500',
  pending: 'bg-yellow-900/60 text-yellow-300',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function statusBadge(status: string) {
  const cls = status === 'active' ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-500';
  return <span className={`px-1.5 py-0.5 rounded text-xs ${cls}`}>{status}</span>;
}

// S3358: avoid nested ternary by resolving the toggle glyph up front.
function ackToggleGlyph(hasEvidence: boolean, expanded: boolean): string {
  if (!hasEvidence) return '';
  return expanded ? ' ▴' : ' ▾';
}

function AckBadge({ ackState, evidence }: Readonly<{ ackState: DeferredAckState; evidence: GrantAckEvidence | null }>) {
  const [expanded, setExpanded] = useState(false);
  const hasEvidence = evidence !== null && Boolean(evidence.kind || evidence.ref || evidence.note);
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!hasEvidence}
        className={`px-1.5 py-0.5 rounded ${ACK_STATE_STYLES[ackState]} ${hasEvidence ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {ackState}{ackToggleGlyph(hasEvidence, expanded)}
      </button>
      {expanded && evidence && (
        <div className="mt-1 text-gray-500 space-y-0.5" data-testid="ack-evidence">
          {evidence.kind && <div>kind: <span className="font-mono text-gray-400">{evidence.kind}</span></div>}
          {evidence.ref && <div>ref: <span className="font-mono text-gray-400">{evidence.ref}</span></div>}
          {evidence.note && <div>note: {evidence.note}</div>}
        </div>
      )}
    </div>
  );
}

function GrantCardView({
  card,
  confirming,
  busy,
  onRevokeClick,
  onConfirmRevoke,
  onCancelRevoke,
  onCleanup,
}: Readonly<{
  card: GrantCard;
  confirming: boolean;
  busy: boolean;
  onRevokeClick: (card: GrantCard) => void;
  onConfirmRevoke: (card: GrantCard) => void;
  onCancelRevoke: () => void;
  onCleanup: (card: GrantCard) => void;
}>) {
  const surplus = surplusIds(card);
  return (
    <div className={surplus.length > 0 ? 'border border-gray-800 bg-[var(--bg-surface)] p-4 space-y-2' : 'rounded-lg border border-gray-800 p-4 space-y-2'} data-testid="grant-card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-indigo-900/40 text-indigo-300 whitespace-nowrap">
            {SOURCE_LABELS[card.source]}
          </span>
          <span className="font-mono text-xs text-gray-200 break-all" title={card.grantee}>{card.grantee}</span>
        </div>
        {statusBadge(card.status)}
      </div>
      {surplus.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-sm text-gray-200">{card.grantee} · {surplus.length + 1} live grants · keep newest, revoke {surplus.length}</p>
          <p className="text-xs text-gray-500 break-all">{card.appDid}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onCleanup(card)}
            className="min-h-11 px-3 py-2 border border-red-900/60 text-xs font-mono text-red-300 hover:bg-red-900/40 disabled:opacity-40"
          >
            Revoke {surplus.length} older {surplus.length === 1 ? 'grant' : 'grants'}
          </button>
        </div>
      )}

      {card.delegatorDid && (
        <p className="text-xs text-gray-500 break-all">Delegator: <span className="font-mono text-gray-300">{card.delegatorDid}</span></p>
      )}
      {card.history && card.history.length > 0 && (
        <details className="text-xs text-gray-500 break-all">
          <summary className="cursor-pointer">Grant history</summary>
          <ul className="mt-2 space-y-2">
            {card.history.map((entry, index) => (
              <li key={`${entry.event}-${entry.createdAt}-${index}`}>
                {entry.event}{entry.capability ? ` (${entry.capability})` : ''} — {formatDate(entry.createdAt)}
                <span className="block">Human actor: <span className="font-mono text-gray-300">{entry.actorDid}</span></span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="text-xs text-gray-500 break-all">
        <span className="uppercase tracking-wide mr-2">Capabilities</span>
        <span className="font-mono text-gray-400">{card.capabilities.join(', ') || '—'}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>issued {formatDate(card.issuedAt)}</span>
        <span>last used {card.lastUsedAt ? formatDate(card.lastUsedAt) : 'never'}</span>
      </div>

      {card.ackState && <AckBadge ackState={card.ackState} evidence={card.ackEvidence} />}

      {surplus.length === 0 && card.revocable && card.revoke && (
        <div className="pt-1">
          {confirming ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400">Revoke this grant?</span>
              <button
                type="button"
                onClick={() => onConfirmRevoke(card)}
                disabled={busy}
                className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40"
              >
                {busy ? '…' : 'Yes, revoke'}
              </button>
              <button
                type="button"
                onClick={onCancelRevoke}
                disabled={busy}
                className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onRevokeClick(card)}
              disabled={busy}
              className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60"
            >
              Revoke
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function renderCardsList(
  loading: boolean,
  cards: GrantCard[],
  rest: {
    confirmingId: string;
    busyId: string;
    onRevokeClick: (card: GrantCard) => void;
    onConfirmRevoke: (card: GrantCard) => void;
    onCancelRevoke: () => void;
    onCleanup: (card: GrantCard) => void;
  },
): ReactNode {
  if (loading) {
    return <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>;
  }
  if (cards.length === 0) {
    return (
      <div className="text-center py-10 border border-gray-800">
        <p className="text-gray-500 text-sm">No standing grants.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <GrantCardView
          key={card.id}
          card={card}
          confirming={rest.confirmingId === card.id}
          busy={Boolean(rest.busyId)}
          onRevokeClick={rest.onRevokeClick}
          onConfirmRevoke={rest.onConfirmRevoke}
          onCancelRevoke={rest.onCancelRevoke}
          onCleanup={rest.onCleanup}
        />
      ))}
    </div>
  );
}

export function GrantsPanel({ transport = defaultTransport }: Readonly<{ transport?: typeof fetch }> = {}) {
  const [canManageGrants, setCanManageGrants] = useState(false);
  const [delegatorDid, setDelegatorDid] = useState('');
  const [actorDid, setActorDid] = useState('');
  const [loading, setLoading] = useState(true);
  const [grants, setGrants] = useState<GrantCard[]>([]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [confirmingId, setConfirmingId] = useState('');
  const [busyId, setBusyId] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mutationRef = useRef(false);

  const { flash, notify } = useFlashNotice(5000);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await transport('/jin/api/grants', { credentials: 'include' });
      if (!res.ok) {
        setCanManageGrants(false);
        setGrants([]);
        return false;
      }
      const data = (await res.json()) as {
        isOperator: boolean; canManageGrants?: boolean; delegatorDid?: string; actorDid?: string; grants: GrantCard[];
      };
      setCanManageGrants(data.canManageGrants ?? data.isOperator);
      setDelegatorDid(data.delegatorDid ?? '');
      setActorDid(data.actorDid ?? '');
      setGrants(data.grants ?? []);
      return true;
    } catch {
      // Silent — this panel simply stays empty on a transient network error.
      return false;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const handleRevokeClick = useCallback((card: GrantCard) => {
    setConfirmingId(card.id);
  }, []);

  const handleCancelRevoke = useCallback(() => {
    setConfirmingId('');
  }, []);

  const handleConfirmRevoke = useCallback(async (card: GrantCard) => {
    if (!card.revoke || mutationRef.current) return;
    mutationRef.current = true;
    setBusyId(card.id);
    try {
      const res = await transport(card.revoke.path, {
        method: card.revoke.method,
        credentials: 'include',
        headers: card.revoke.body ? { 'Content-Type': 'application/json' } : undefined,
        body: card.revoke.body ? JSON.stringify(card.revoke.body) : undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Revoke failed (${res.status})`);
        return;
      }
      notify('ok', 'Grant revoked.');
      setConfirmingId('');
    } catch {
      notify('err', 'Revoke could not be confirmed because of a network error. Refresh and try again.');
    } finally {
      const refreshed = await load(true);
      if (!refreshed) notify('err', 'Could not refresh grants. Refresh before trying again.');
      setBusyId('');
      mutationRef.current = false;
    }
  }, [load, notify, transport]);

  const handleCleanup = useCallback(async (card: GrantCard) => {
    const ids = surplusIds(card);
    if (ids.length === 0 || mutationRef.current) return;
    mutationRef.current = true;
    setBusyId(card.id);
    let failed = 0;
    await forEachSequential(ids, async attestationId => {
      try {
        const res = await transport('/api/auth/revoke', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attestationId }),
        });
        // The existing route returns 409 only for an already-revoked grant.
        if (!res.ok && res.status !== 409) failed += 1;
      } catch {
        failed += 1;
      }
    });
    const refreshed = await load(true);
    if (failed > 0) {
      notify('err', `${failed} of ${ids.length} older grants could not be confirmed revoked. Newest kept. ${refreshed ? 'Grants refreshed; retry remaining older grants.' : 'Refresh failed; refresh before retrying.'}`);
    } else if (!refreshed) {
      notify('err', 'Older grants revoked; newest kept. Could not refresh grants. Refresh before trying again.');
    } else {
      notify('ok', 'Older grants revoked. Newest kept.');
    }
    setConfirmingId('');
    setBusyId('');
    mutationRef.current = false;
  }, [load, notify, transport]);

  // Unauthorized principals see nothing — no header, no empty-state, no card. This
  // also holds during the initial load so nobody briefly sees panel chrome
  // before the operator check resolves.
  if (!canManageGrants) return null;

  const visible = grants.filter((g) => g.status !== 'revoked');
  const history = grants.filter((g) => g.status === 'revoked');
  const actions = {
    confirmingId,
    busyId,
    onRevokeClick: handleRevokeClick,
    onConfirmRevoke: handleConfirmRevoke,
    onCancelRevoke: handleCancelRevoke,
    onCleanup: handleCleanup,
  };

  return (
    <section id="grants" className={`${styles.panel} mt-8`} data-testid="grants-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="font-mono text-base font-semibold text-gray-100">Grants</h2>
          <p className="text-xs text-gray-500">Who acts for you, with what capabilities — one-tap revoke</p>
          {delegatorDid && <p className="text-xs text-gray-400 break-all">Organization delegator: <span className="font-mono">{delegatorDid}</span></p>}
          {actorDid && <p className="text-xs text-gray-500 break-all">Authenticated human: <span className="font-mono">{actorDid}</span></p>}
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono">
          <Link
            href="/auth/agents"
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Manage capabilities →
          </Link>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.target.checked)}
              className="accent-amber-500"
            />
            <span>show revoked</span>
          </label>
          <button type="button" onClick={() => load()} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            ↺ refresh
          </button>
        </div>
      </div>

      {flash && (
        <output role={flash.type === 'err' ? 'alert' : undefined} className={`block mb-3 px-3 py-2 text-xs font-medium ${flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
          {flash.msg}
        </output>
      )}

      {renderCardsList(loading, visible, actions)}
      {showRevoked && history.length > 0 && (
        <div className="mt-4 space-y-3" aria-label="Revoked grant history">
          <h3 className="font-mono text-sm text-gray-400">Revoked history</h3>
          {renderCardsList(loading, history, actions)}
        </div>
      )}
    </section>
  );
}
