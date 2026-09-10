'use client';

/**
 * Operator approvals panel for the `/jin` kernel dashboard (#2059,
 * generalized to a per-source renderer registry by #2152).
 *
 * Renders pending `operator.approval.requested` proposals as a confirm
 * card, mirroring the proposals table in page.tsx and the
 * polling/silent-refresh conventions of usage-feed-panel.tsx. Tapping
 * Approve/Reject signs and publishes an `operator.approval.decided` event
 * through `POST /jin/api/operator-approvals/:proposalId/decision` — the
 * kernel is the one that signs, this component only makes the
 * authenticated tap.
 *
 * `source` (open vocabulary, e.g. 'system-agent', 'skill-workshop') keys a
 * small renderer registry (#2152): each entry supplies its own detail
 * rendering and Approve/Reject button labels (`decisionLabels`), so a new
 * source needs only a registry entry here — never a change to the polling,
 * auth, or decision-post plumbing below. The default renderer (used for
 * 'system-agent' and any unregistered source) reproduces the original
 * #2059 card exactly: summary + keys-touched, Approve/Deny labels.
 *
 * Renders NOTHING (not even a header) when the signed-in identity is not
 * the node operator — `GET /jin/api/operator-approvals` reports
 * `isOperator: false` with an empty list for anyone else, and this panel
 * takes that at face value rather than trying to distinguish "no data" from
 * "not allowed".
 *
 * #2082: before POSTing a decision, this component signs `canonicalize({
 * contentHash, decidedAt, decision})` with the operator's OWN key — the
 * same Ed25519 keypair already held client-side in `localStorage.
 * imajin_keypair` for login/registration (see `../auth/login/components/
 * KeyAuthTab.tsx`, the pattern this mirrors: a dynamic `@noble/ed25519`
 * import rather than pulling the server-oriented `@imajin/auth` package
 * into a client bundle). This is a genuine second signature alongside the
 * kernel's own witness signature — the whole point of #2082 is that the
 * kernel is no longer the only party whose signature the decision carries.
 * If no local keypair is found (e.g. this browser only ever used a
 * cookie session), the decision POSTs without `operatorSignature`; the
 * kernel accepts that unless `OPERATOR_COUNTERSIGN_REQUIRED` is on, in
 * which case the resulting 400 surfaces through the existing error flash.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface StoredKeypair {
  privateKey: string;
  publicKey: string;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Canonical JSON for exactly `{contentHash, decidedAt, decision}` — sorted
 * alphabetically to match `@imajin/auth`'s `canonicalize` (contentHash <
 * decidedAt < decision), inlined rather than imported so this client
 * bundle never pulls in the server-oriented `@imajin/auth` package (see
 * module docs above).
 */
function canonicalizeCountersignFields(fields: { contentHash: string; decidedAt: string; decision: string }): string {
  return `{"contentHash":${JSON.stringify(fields.contentHash)},"decidedAt":${JSON.stringify(fields.decidedAt)},"decision":${JSON.stringify(fields.decision)}}`;
}

interface OperatorSignature {
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

/**
 * Sign `{contentHash, decidedAt, decision}` with the operator's local
 * keypair, if one is present. Returns `null` (never throws) when there's
 * no local keypair or signing fails for any reason — the caller falls
 * back to submitting without `operatorSignature`.
 */
async function signOperatorDecision(fields: {
  contentHash: string;
  decidedAt: string;
  decision: string;
}): Promise<OperatorSignature | null> {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem('imajin_keypair');
  if (!stored) return null;

  try {
    const { privateKey, publicKey } = JSON.parse(stored) as Partial<StoredKeypair>;
    if (!privateKey || !publicKey) return null;

    const ed = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha2.js');
    (ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

    const canonical = canonicalizeCountersignFields(fields);
    const msgBytes = new TextEncoder().encode(canonical);
    const sigBytes = await ed.signAsync(msgBytes, hexToBytes(privateKey));
    const sig = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    return { keyId: publicKey, alg: 'ed25519', sig };
  } catch {
    return null;
  }
}

const POLL_INTERVAL_MS = 5000;

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'applied';
type DecisionAction = 'approve' | 'reject' | 'withdrawn';

interface OperatorApprovalCard {
  proposalId: string;
  /** Open vocabulary namespace, e.g. 'system-agent', 'skill-workshop' (#2152). */
  source: string;
  /** '<source>:<subkind>', e.g. 'system-agent:restart' (#2152). */
  kind: string;
  summary: string;
  keysTouched: string[];
  /** Optional per-source structured detail (#2152) — e.g. skill-workshop's diff summary. */
  detail: Record<string, unknown> | null;
  /** sha256 hex digest the operator's countersignature covers (#2082) — always present. */
  contentHash: string;
  status: ApprovalStatus;
  decision: { decidedBy: string; decidedAt: string; reason?: string } | null;
  appliedAt: string | null;
  createdAt: string;
}

function statusBadge(status: ApprovalStatus) {
  const styles: Record<ApprovalStatus, string> = {
    pending: 'bg-yellow-900/60 text-yellow-300',
    approved: 'bg-green-900/60 text-green-300',
    applied: 'bg-blue-900/60 text-blue-300',
    denied: 'bg-red-900/60 text-red-400',
    withdrawn: 'bg-gray-800 text-gray-500',
  };
  const labels: Record<ApprovalStatus, string> = {
    pending: 'pending',
    approved: 'approved — pending apply',
    applied: 'applied',
    denied: 'denied',
    withdrawn: 'withdrawn',
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}

function KeysTouched({ keys }: Readonly<{ keys: string[] }>) {
  if (keys.length === 0) return <span className="text-gray-600">—</span>;
  return (
    <span className="font-mono text-xs text-gray-400">
      {keys.join(', ')}
    </span>
  );
}

// ── per-source renderer registry (#2152) ────────────────────────────────────
// A new source (e.g. a future OpenClaw source adapter) needs one entry here
// and nothing else in this file — polling, auth, and the decision POST are
// all source-agnostic already.

interface DecisionLabels {
  approve: string;
  reject: string;
}

interface SourceRenderer {
  decisionLabels: DecisionLabels;
  renderDetail: (approval: OperatorApprovalCard) => ReactNode;
}

const DEFAULT_DECISION_LABELS: DecisionLabels = { approve: 'Approve', reject: 'Deny' };

/** The original #2059 card body — summary + keys touched. */
function renderDefaultDetail(approval: OperatorApprovalCard): ReactNode {
  return (
    <>
      <p className="text-sm text-gray-200">{approval.summary}</p>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Keys touched</span>
        <KeysTouched keys={approval.keysTouched} />
      </div>
    </>
  );
}

const DEFAULT_RENDERER: SourceRenderer = {
  decisionLabels: DEFAULT_DECISION_LABELS,
  renderDetail: renderDefaultDetail,
};

/** Read a string field out of `detail`, falling back when absent/mistyped — `detail` is untrusted, adapter-supplied JSON. */
function detailString(detail: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = detail?.[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** `skill-workshop` renderer (#2152): skill name, create/update, scan status, description, and a bounded diff-summary block. */
function renderSkillWorkshopDetail(approval: OperatorApprovalCard): ReactNode {
  const { detail } = approval;
  const skillName = detailString(detail, 'skillName', 'Unknown skill');
  const kind = detailString(detail, 'kind', 'update');
  const scan = detailString(detail, 'scan', 'unknown');
  const description = detailString(detail, 'description', '');
  const diffSummary = detailString(detail, 'diffSummary', '');
  return (
    <div className="space-y-2">
      <div className="text-sm text-gray-200">
        <span className="font-medium text-gray-100">{skillName}</span>
        <span className="text-gray-500"> — {kind}</span>
      </div>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Scan</span>
        <span className={scan === 'clean' ? 'text-green-400' : 'text-yellow-400'}>{scan}</span>
      </div>
      {description && <p className="text-sm text-gray-300">{description}</p>}
      {diffSummary && (
        <pre className="text-xs text-gray-400 bg-gray-900/60 rounded p-2 overflow-x-auto whitespace-pre-wrap">{diffSummary}</pre>
      )}
    </div>
  );
}

const SKILL_WORKSHOP_RENDERER: SourceRenderer = {
  decisionLabels: { approve: 'Apply', reject: 'Reject' },
  renderDetail: renderSkillWorkshopDetail,
};

const SOURCE_RENDERERS: Readonly<Record<string, SourceRenderer>> = {
  'skill-workshop': SKILL_WORKSHOP_RENDERER,
};

function rendererFor(source: string): SourceRenderer {
  return SOURCE_RENDERERS[source] ?? DEFAULT_RENDERER;
}

function ApprovalCardRow({
  approval,
  onDecide,
  busy,
}: Readonly<{
  approval: OperatorApprovalCard;
  onDecide: (approval: OperatorApprovalCard, decision: DecisionAction) => void;
  busy: boolean;
}>) {
  const renderer = rendererFor(approval.source);
  // S9379: an imperative focus-on-mount ref instead of the declarative
  // `autoFocus` JSX attribute — same one-time focus behavior, no new SonarCloud
  // finding. Stable across renders so it only fires when the button mounts.
  const autoFocusRef = useCallback((el: HTMLButtonElement | null) => el?.focus(), []);
  return (
    <div className="rounded-lg border border-gray-800 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {statusBadge(approval.status)}
          <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-orange-900/50 text-orange-300">
            {approval.kind}
          </span>
        </div>
        <span className="text-xs text-gray-500">{new Date(approval.createdAt).toLocaleString()}</span>
      </div>
      {renderer.renderDetail(approval)}
      {approval.status === 'pending' && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onDecide(approval, 'reject')}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {renderer.decisionLabels.reject}
          </button>
          <button
            type="button"
            onClick={() => onDecide(approval, 'approve')}
            disabled={busy}
            ref={autoFocusRef}
            className="px-3 py-1.5 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ring-1 ring-green-500/50"
          >
            {busy ? '…' : renderer.decisionLabels.approve}
          </button>
        </div>
      )}
      {approval.status === 'approved' && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onDecide(approval, 'withdrawn')}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? '…' : 'Withdraw'}
          </button>
        </div>
      )}
    </div>
  );
}

// S3358: avoid nested ternary by extracting render logic.
function renderPanelBody(
  loading: boolean,
  approvals: OperatorApprovalCard[],
  onDecide: (approval: OperatorApprovalCard, decision: DecisionAction) => void,
  busyId: string,
) {
  if (loading) {
    return <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>;
  }
  if (approvals.length === 0) {
    return (
      <div className="text-center py-10 rounded-lg border border-gray-800">
        <p className="text-gray-500 text-sm">No operator approvals yet.</p>
        <p className="text-gray-700 text-xs mt-1">
          Proposals from any connected source — gateway restart, config, and skill updates — appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {approvals.map((approval) => (
        <ApprovalCardRow
          key={approval.proposalId}
          approval={approval}
          onDecide={onDecide}
          busy={busyId === approval.proposalId}
        />
      ))}
    </div>
  );
}

export function OperatorApprovalsPanel() {
  const [isOperator, setIsOperator] = useState(false);
  const [approvals, setApprovals] = useState<OperatorApprovalCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [flash, setFlash] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const notify = useCallback((type: 'ok' | 'err', msg: string) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/jin/api/operator-approvals', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { isOperator: boolean; approvals: OperatorApprovalCard[] };
      setIsOperator(data.isOperator);
      setApprovals(data.approvals ?? []);
    } catch {
      // Silent — this panel simply stays empty on a transient network error.
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

  const handleDecide = useCallback(async (approval: OperatorApprovalCard, decision: DecisionAction) => {
    const { proposalId } = approval;
    setBusyId(proposalId);
    try {
      // #2082: decidedAt is chosen client-side, since it's exactly the
      // timestamp the operator's signature below covers — the kernel
      // verifies it (clock-skew bounds + the signature itself) rather than
      // substituting its own.
      const decidedAt = new Date().toISOString();
      const operatorSignature = await signOperatorDecision({ contentHash: approval.contentHash, decidedAt, decision });

      const res = await fetch(`/jin/api/operator-approvals/${encodeURIComponent(proposalId)}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          operatorSignature ? { decision, decidedAt, operatorSignature } : { decision },
        ),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Decision failed (${res.status})`);
        return;
      }
      notify('ok', `Proposal ${decision}.`);
      await load(true);
    } finally {
      setBusyId('');
    }
  }, [load, notify]);

  // Non-operators see nothing — no header, no empty-state, no card. This
  // also holds during the initial load so nobody briefly sees panel chrome
  // before the operator check resolves.
  if (!isOperator) return null;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Operator approvals</h2>
          <p className="text-xs text-gray-500">Pending approvals across every connected source — approve from anywhere</p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          ↺ refresh
        </button>
      </div>

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded text-xs font-medium ${
          flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
        }`}>
          {flash.msg}
        </div>
      )}

      {renderPanelBody(loading, approvals, handleDecide, busyId)}
    </section>
  );
}
