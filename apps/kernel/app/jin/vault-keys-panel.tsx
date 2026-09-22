'use client';

/**
 * Vault section on `/jin` (#2247) — one card per vault-minted key, rendered
 * as a TIMELINE, never a value. There is deliberately NO reveal or copy
 * affordance anywhere in this file: the private key material never leaves
 * the vault (see `apps/kernel/src/lib/vault/mint.ts`), so there is nothing
 * to show. What this panel renders is the *history* of the key — minted,
 * granted, fetched, acked, rotated/revoked — per the UX note on #2241
 * ("Visibility of the record, invisibility of the material").
 *
 * Mint/grant/rotate/revoke are proposed here but SIGNED on the existing
 * operator-approvals rail (#2059/#2152, rendered by
 * `operator-approvals-panel.tsx` right below this panel on the page):
 * submitting a form here only raises a `vault:*` proposal
 * (`POST /jin/api/vault-proposals`); approving it there is the actual
 * signing event, and the vault mutation itself runs server-side.
 *
 * "Claim pending service" (UX note #3) is the claimable pending-service
 * self-registration/pairing moment. #2243 (loadFromVault fetch-at-boot,
 * merged into main) deliberately does NOT implement it — that pairing flow
 * needs a service/host-shaped extension of the #1834 claimable-stub
 * primitive that doesn't exist yet, and is called out as its own follow-up
 * in #2243's own PR description. Rendered here as an inert,
 * clearly-labelled stub until that follow-up lands. TODO(#2243): wire this
 * up once the claim/pairing events exist.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

type VaultKeyTimelineEventType = 'minted' | 'granted' | 'fetched' | 'acked' | 'rotated' | 'revoked';

interface VaultKeyTimelineEvent {
  type: VaultKeyTimelineEventType;
  at: string;
  alert?: boolean;
  detail: Record<string, unknown>;
}

interface VaultKeyGrantSummary {
  grantId: string;
  grantedTo: string;
  purpose: string | null;
  oneTime: boolean;
  status: string;
  expiresAt: string | null;
  consumedAt: string | null;
  lastFetchedAt: string | null;
  ackedAt: string | null;
  ackOutcome: string | null;
}

interface VaultKeyCard {
  did: string;
  publicKey: string;
  purpose: string;
  requestedBy: string;
  mintedBy: string;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  grant: VaultKeyGrantSummary | null;
  timeline: VaultKeyTimelineEvent[];
  heldBy: string | null;
  lastAckAt: string | null;
  fetchWithoutAck: boolean;
}

interface HandProvisionedField {
  field: string;
  senderDid: string;
  timestamp: string;
  custodyScheme: string;
  status: 'active' | 'deleted';
}

type RevokeTier = 'withdraw' | 'tombstone' | 'destroy';

const POLL_INTERVAL_MS = 5000;

/** "Nm ago" / "Nh ago" / "Nd ago" — coarse, matching the UX note's own "last ack Nm ago" phrasing. */
function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || Number.isNaN(ms)) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Safely read a string field out of a timeline row's `detail` (untrusted,
 * server-shaped JSON typed as `Record<string, unknown>`). Falls back to
 * `—` for anything that isn't actually a string, rather than blindly
 * `String()`-coercing a possible object into `'[object Object]'`.
 */
function detailString(detail: Record<string, unknown>, key: string): string {
  const value = detail[key];
  return typeof value === 'string' && value.length > 0 ? value : '—';
}

function timelineRowLabel(event: VaultKeyTimelineEvent): string {
  switch (event.type) {
    case 'minted':
      return `Minted by ${detailString(event.detail, 'by')}`;
    case 'granted':
      return `Granted to ${detailString(event.detail, 'to')}${event.detail.oneTime ? ' (one-time)' : ''}`;
    case 'fetched':
      return `Fetched by ${detailString(event.detail, 'consumer')}`;
    case 'acked':
      return `Acked — ${detailString(event.detail, 'outcome')}`;
    case 'rotated':
      return 'Rotated';
    case 'revoked':
      return `Revoked by ${detailString(event.detail, 'by')}`;
    default:
      return event.type;
  }
}

function VaultKeyTimelineRow({ event }: Readonly<{ event: VaultKeyTimelineEvent }>) {
  const alertClass = event.alert
    ? 'border-red-700 bg-red-950/40 text-red-300'
    : 'border-gray-800 text-gray-300';
  return (
    <li className={`text-xs px-2 py-1 border-l-2 ${alertClass}`} data-timeline-type={event.type} data-alert={event.alert ? 'true' : 'false'}>
      <span>{timelineRowLabel(event)}</span>
      <span className="text-gray-500 ml-2">{new Date(event.at).toLocaleString()}</span>
      {event.alert && <span className="ml-2 text-red-400 font-medium">no ack yet</span>}
    </li>
  );
}

function statusLine(card: VaultKeyCard): string {
  if (card.status === 'revoked') return 'revoked';
  if (!card.heldBy) return 'not yet fetched';
  const ago = timeAgo(card.lastAckAt);
  return ago ? `held in memory by ${card.heldBy}, last ack ${ago}` : `held in memory by ${card.heldBy}, no ack yet`;
}

interface GrantFormState {
  grantedTo: string;
  purpose: string;
  oneTime: boolean;
}

interface RevokeFormState {
  tier: RevokeTier;
}

function VaultKeyCardView({
  card,
  onGrant,
  onRotate,
  onRevoke,
  busy,
}: Readonly<{
  card: VaultKeyCard;
  onGrant: (did: string, form: GrantFormState) => Promise<void>;
  onRotate: (did: string) => Promise<void>;
  onRevoke: (did: string, form: RevokeFormState) => Promise<void>;
  busy: boolean;
}>) {
  const [openAction, setOpenAction] = useState<'none' | 'grant' | 'revoke'>('none');
  const [grantForm, setGrantForm] = useState<GrantFormState>({ grantedTo: '', purpose: '', oneTime: true });
  const [revokeTier, setRevokeTier] = useState<RevokeTier>('withdraw');

  const submitGrant = async (e: FormEvent) => {
    e.preventDefault();
    await onGrant(card.did, grantForm);
    setOpenAction('none');
  };

  const submitRevoke = async (e: FormEvent) => {
    e.preventDefault();
    await onRevoke(card.did, { tier: revokeTier });
    setOpenAction('none');
  };

  return (
    <div className="rounded-lg border border-gray-800 p-4 space-y-3" data-testid="vault-key-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="font-mono text-xs text-gray-200">{card.did}</span>
          <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${card.status === 'active' ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-500'}`}>
            {card.status}
          </span>
        </div>
      </div>
      <p className="text-xs text-gray-500">{statusLine(card)}</p>
      <ul className="space-y-1">
        {card.timeline.map((event) => (
          <VaultKeyTimelineRow key={`${event.type}-${event.at}`} event={event} />
        ))}
      </ul>

      {card.status === 'active' && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => setOpenAction(openAction === 'grant' ? 'none' : 'grant')}
            disabled={busy}
            className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40"
          >
            Grant access
          </button>
          <button
            type="button"
            onClick={() => onRotate(card.did)}
            disabled={busy}
            className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40"
          >
            Rotate
          </button>
          <button
            type="button"
            onClick={() => setOpenAction(openAction === 'revoke' ? 'none' : 'revoke')}
            disabled={busy}
            className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40"
          >
            Revoke
          </button>
        </div>
      )}

      {openAction === 'grant' && (
        <form onSubmit={submitGrant} className="space-y-2 border-t border-gray-800 pt-2">
          <input
            type="text"
            placeholder="Consumer DID (grantedTo)"
            value={grantForm.grantedTo}
            onChange={(e) => setGrantForm({ ...grantForm, grantedTo: e.target.value })}
            className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
            required
          />
          <input
            type="text"
            placeholder="Purpose (optional)"
            value={grantForm.purpose}
            onChange={(e) => setGrantForm({ ...grantForm, purpose: e.target.value })}
            className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={grantForm.oneTime}
              onChange={(e) => setGrantForm({ ...grantForm, oneTime: e.target.checked })}
              className="accent-amber-500"
            />
            <span>one-time</span>
          </label>
          <button type="submit" disabled={busy} className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40">
            Propose grant
          </button>
        </form>
      )}

      {openAction === 'revoke' && (
        <form onSubmit={submitRevoke} className="space-y-2 border-t border-gray-800 pt-2">
          <select
            value={revokeTier}
            onChange={(e) => setRevokeTier(e.target.value as RevokeTier)}
            className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
          >
            <option value="withdraw">Withdraw — stop new fetches</option>
            <option value="tombstone">Tombstone — destroy material, keep record</option>
            <option value="destroy">Destroy — hard, irreversible</option>
          </select>
          {revokeTier === 'destroy' && (
            <p className="text-xs text-red-300 bg-red-950/40 border border-red-900/60 rounded p-2">
              Destroy is irreversible. This key will never be fetchable again, and this cannot be undone.
            </p>
          )}
          <button type="submit" disabled={busy} className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40">
            Propose {revokeTier}
          </button>
        </form>
      )}
    </div>
  );
}

function MintForm({
  purpose,
  requesterDid,
  onPurposeChange,
  onRequesterDidChange,
  onMint,
  busy,
}: Readonly<{
  purpose: string;
  requesterDid: string;
  onPurposeChange: (value: string) => void;
  onRequesterDidChange: (value: string) => void;
  onMint: (purpose: string, requesterDid: string) => Promise<void>;
  busy: boolean;
}>) {
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onMint(purpose, requesterDid);
    onPurposeChange('');
    onRequesterDidChange('');
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-gray-800 p-3">
      <input
        type="text"
        placeholder="Purpose (e.g. prod-corpus signing key)"
        value={purpose}
        onChange={(e) => onPurposeChange(e.target.value)}
        className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        required
      />
      <input
        type="text"
        placeholder="Requester DID (who receives the sealed key)"
        value={requesterDid}
        onChange={(e) => onRequesterDidChange(e.target.value)}
        className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        required
      />
      <button type="submit" disabled={busy} className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40">
        Propose mint
      </button>
    </form>
  );
}

/**
 * "Claim pending service" (UX note #3) — stubbed pending the claim/pairing
 * follow-up flagged in #2243's own PR description (#2243 itself, the
 * fetch-at-boot helper, is merged; the pairing/self-registration moment is
 * not). Always rendered, always disabled: this documents the intended
 * surface without pretending it works. TODO(#2243): replace this whole
 * component once that follow-up's claim/pairing events exist.
 */
function ClaimPendingServiceStub() {
  return (
    <div className="rounded-lg border border-dashed border-gray-800 p-3 text-xs text-gray-600">
      <span className="font-medium text-gray-500">Claim pending service</span>
      <span className="ml-2">— waiting on the claim/pairing follow-up (#2243)</span>
      <button type="button" disabled className="ml-3 px-2 py-0.5 rounded bg-gray-800 text-gray-600 cursor-not-allowed">
        Claim
      </button>
    </div>
  );
}

function renderKeysList(loading: boolean, keys: VaultKeyCard[], rest: {
  onGrant: (did: string, form: GrantFormState) => Promise<void>;
  onRotate: (did: string) => Promise<void>;
  onRevoke: (did: string, form: RevokeFormState) => Promise<void>;
  busy: boolean;
}): ReactNode {
  if (loading) {
    return <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>;
  }
  if (keys.length === 0) {
    return (
      <div className="text-center py-10 rounded-lg border border-gray-800">
        <p className="text-gray-500 text-sm">No vault-minted keys yet.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {keys.map((card) => (
        <VaultKeyCardView key={card.did} card={card} {...rest} />
      ))}
    </div>
  );
}

export function VaultKeysPanel() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<VaultKeyCard[]>([]);
  const [handProvisioned, setHandProvisioned] = useState<HandProvisionedField[]>([]);
  const [showHandProvisioned, setShowHandProvisioned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [mintPurpose, setMintPurpose] = useState('');
  const [mintRequesterDid, setMintRequesterDid] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const notify = useCallback((type: 'ok' | 'err', msg: string) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 5000);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/vault/mint/cards', { credentials: 'include' });
      if (!res.ok) {
        setVisible(false);
        return;
      }
      const data = (await res.json()) as { keys: VaultKeyCard[]; handProvisioned: HandProvisionedField[] };
      setVisible(true);
      setKeys(data.keys ?? []);
      setHandProvisioned(data.handProvisioned ?? []);
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

  const raiseProposal = useCallback(async (kind: 'mint' | 'grant' | 'rotate' | 'revoke', detail: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/jin/api/vault-proposals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, detail }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Failed to raise proposal (${res.status})`);
        return;
      }
      notify('ok', 'Proposal raised — approve it below to sign.');
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const handleMint = useCallback((purpose: string, requesterDid: string) =>
    raiseProposal('mint', { purpose, requesterDid }), [raiseProposal]);

  const handleGrant = useCallback((did: string, form: GrantFormState) =>
    raiseProposal('grant', { did, grantedTo: form.grantedTo, purpose: form.purpose || undefined, oneTime: form.oneTime }), [raiseProposal]);

  const handleRotate = useCallback((did: string) =>
    raiseProposal('rotate', { did }), [raiseProposal]);

  const handleRevoke = useCallback((did: string, form: RevokeFormState) =>
    raiseProposal('revoke', { did, tier: form.tier }), [raiseProposal]);

  const handleProposeReplacement = useCallback((field: string) => {
    // Derive a reasonable purpose from the field name and pre-fill the mint
    // form above — the operator still fills in requesterDid and submits
    // deliberately, rather than this silently raising an incomplete proposal.
    const derivedPurpose = field.replace(/^.*[:/]/, '');
    setMintPurpose(`replace ${derivedPurpose}`);
    notify('ok', 'Mint form pre-filled above — add the requester DID and submit to propose.');
  }, [notify]);

  if (!visible) return null;

  return (
    <section className="mt-8" data-testid="vault-keys-panel">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Vault</h2>
          <p className="text-xs text-gray-500">Vault-native service keys — a timeline, never a value. No reveal, no copy.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showHandProvisioned}
              onChange={(e) => setShowHandProvisioned(e.target.checked)}
              className="accent-amber-500"
            />
            <span>hand-provisioned</span>
          </label>
          <button type="button" onClick={() => load()} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            ↺ refresh
          </button>
        </div>
      </div>

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded text-xs font-medium ${flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
          {flash.msg}
        </div>
      )}

      <div className="mb-3">
        <MintForm
          purpose={mintPurpose}
          requesterDid={mintRequesterDid}
          onPurposeChange={setMintPurpose}
          onRequesterDidChange={setMintRequesterDid}
          onMint={handleMint}
          busy={busy}
        />
      </div>

      <div className="mb-3">
        <ClaimPendingServiceStub />
      </div>

      {showHandProvisioned && (
        <div className="mb-3 space-y-2" data-testid="hand-provisioned-list">
          {handProvisioned.length === 0 ? (
            <p className="text-xs text-gray-600">No hand-provisioned fields found.</p>
          ) : (
            handProvisioned.map((f) => (
              <div key={f.field} className="flex items-center justify-between text-xs rounded border border-gray-800 px-2 py-1.5">
                <span className="font-mono text-gray-400">{f.field}</span>
                <button
                  type="button"
                  onClick={() => handleProposeReplacement(f.field)}
                  disabled={busy}
                  className="px-2 py-0.5 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40"
                >
                  Propose mint replacement
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {renderKeysList(loading, keys, { onGrant: handleGrant, onRotate: handleRotate, onRevoke: handleRevoke, busy })}
    </section>
  );
}
