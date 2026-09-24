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
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { revokeTierLabel } from '@/src/lib/vault/revoke-tier';

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

// #2293: 'expired' is a github:*-only terminal (a windowed approval whose
// TTL lapsed unused, or one withdrawn early) — added to the shared status
// vocabulary rather than forking a github-specific type, same posture as
// #2221 extending `outcome` for one kind without a kind-specific type.
type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'applied' | 'expired';
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
  /** Post-exec outcome follow-up (#2221 exec.command exitCode/durationMs/outputHash; #2293 github approvedUntil/ownerAuthorization) — null until decided. */
  outcome: Record<string, unknown> | null;
  appliedAt: string | null;
  createdAt: string;
}

/** True once a pending approval's own `detail.expiresAt` has passed (#2221) — undefined/malformed `expiresAt` never expires. */
function isApprovalExpired(approval: OperatorApprovalCard): boolean {
  const expiresAt = approval.detail?.expiresAt;
  if (typeof expiresAt !== 'string') return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now();
}

function statusBadge(status: ApprovalStatus) {
  const styles: Record<ApprovalStatus, string> = {
    pending: 'bg-yellow-900/60 text-yellow-300',
    approved: 'bg-green-900/60 text-green-300',
    applied: 'bg-blue-900/60 text-blue-300',
    denied: 'bg-red-900/60 text-red-400',
    withdrawn: 'bg-gray-800 text-gray-500',
    expired: 'bg-gray-800 text-gray-500',
  };
  const labels: Record<ApprovalStatus, string> = {
    pending: 'pending',
    approved: 'approved — pending apply',
    applied: 'applied',
    denied: 'denied',
    withdrawn: 'withdrawn',
    expired: 'expired',
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
  /** Static for most sources; a function when the label depends on the approval itself (e.g. vault:revoke's tier, #2247). */
  decisionLabels: DecisionLabels | ((approval: OperatorApprovalCard) => DecisionLabels);
  renderDetail: (approval: OperatorApprovalCard) => ReactNode;
  /**
   * Optional (#2293): when present, REPLACES the default two-button
   * (Approve/Reject) pending-state row entirely — for a source whose
   * decision needs more than two choices (github:*'s No/Yes/5m/24h TTL
   * picker). Every other source is unaffected — omitting this hook keeps
   * the original two-button affordance exactly as before.
   */
  renderPendingActions?: (
    approval: OperatorApprovalCard,
    onDecide: (approval: OperatorApprovalCard, decision: DecisionAction, mode?: string) => void,
    busy: boolean,
  ) => ReactNode;
}

/** Resolve a renderer's decisionLabels, calling it through when it's per-approval (#2247). */
function resolveDecisionLabels(renderer: SourceRenderer, approval: OperatorApprovalCard): DecisionLabels {
  return typeof renderer.decisionLabels === 'function' ? renderer.decisionLabels(approval) : renderer.decisionLabels;
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

// `gateway-exec` (#2221): forwarded OpenClaw host-exec approvals. Only
// allow-once/deny are ever offered — there is no third button, so
// allow-always is unreachable from this card by construction (the kernel
// additionally rejects it server-side if a caller hits the API directly,
// see exec-command-approvals.ts).

/** `mm:ss` (or `h:mm:ss` past an hour) countdown text, or 'expired'. Pure — no hooks — so it can be called from a ticking child component. */
function formatExpiryCountdown(expiresAtMs: number, nowMs: number): string {
  if (Number.isNaN(expiresAtMs)) return '';
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) return 'expired';

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `expires in ${hours}:${pad(minutes)}:${pad(seconds)}` : `expires in ${minutes}:${pad(seconds)}`;
}

function ExecOutcomeView({ outcome }: Readonly<{ outcome: Record<string, unknown> }>) {
  const exitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : null;
  const durationMs = typeof outcome.durationMs === 'number' ? outcome.durationMs : null;
  const outputHash = typeof outcome.outputHash === 'string' ? outcome.outputHash : '';
  if (exitCode === null || durationMs === null) return null;
  const succeeded = exitCode === 0;
  return (
    <div className="text-xs text-gray-500 border-t border-gray-800 pt-2">
      <span className="uppercase tracking-wide mr-2">Outcome</span>
      <span className={succeeded ? 'text-green-400' : 'text-red-400'}>exit {exitCode}</span>
      <span className="mx-2">·</span>
      <span>{durationMs}ms</span>
      <span className="mx-2">·</span>
      <span className="font-mono">{outputHash}</span>
    </div>
  );
}

/** Owns the second-by-second countdown tick — a real component (not a plain render function) so it can hold its own `useState`/`useEffect` without violating the rules of hooks. */
function ExecCommandDetailView({ approval }: Readonly<{ approval: OperatorApprovalCard }>) {
  const { detail, outcome } = approval;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const command = detailString(detail, 'command', '');
  const host = detailString(detail, 'host', 'unknown host');
  const cwd = detailString(detail, 'cwd', '—');
  const agentId = detailString(detail, 'agentId', '—');
  const sessionKey = detailString(detail, 'sessionKey', '—');
  const expiresAtRaw = detail?.expiresAt;
  const expiresAtMs = typeof expiresAtRaw === 'string' ? Date.parse(expiresAtRaw) : NaN;
  const countdown = formatExpiryCountdown(expiresAtMs, nowMs);

  return (
    <div className="space-y-2">
      {/* Verbatim, never summarised/truncated (#2221) — the hash-bearing content is
          the full string; the scrollable max-height is a purely visual collapse. */}
      <pre className="text-xs text-gray-100 bg-gray-900/80 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{command}</pre>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-mono">{host}</span>
        <span>cwd: <span className="font-mono text-gray-400">{cwd}</span></span>
        <span>agent: <span className="font-mono text-gray-400">{agentId}</span> / <span className="font-mono text-gray-400">{sessionKey}</span></span>
        {countdown && <span className={countdown === 'expired' ? 'text-red-400 font-medium' : 'text-gray-500'}>{countdown}</span>}
      </div>
      {outcome && <ExecOutcomeView outcome={outcome} />}
    </div>
  );
}

const GATEWAY_EXEC_RENDERER: SourceRenderer = {
  decisionLabels: { approve: 'Allow once', reject: 'Deny' },
  renderDetail: (approval) => <ExecCommandDetailView approval={approval} />,
};

// `vault` (#2247): mint/grant/rotate/revoke proposals raised either from
// the /jin Vault section (`POST /jin/api/vault-proposals`) or by an agent
// in chat (`POST /notify/api/send`). Approving one of these IS the signing
// event — the actual mutation runs server-side in
// `src/lib/vault/approvals-execution.ts` right after this card's decision
// is recorded. `kind` is namespaced `vault:<action>` (#2152's open
// vocabulary), so this renderer dispatches on the full kind string rather
// than a separate `detail.action` field.

function renderVaultMintDetail(approval: OperatorApprovalCard): ReactNode {
  const { detail } = approval;
  const purpose = detailString(detail, 'purpose', '—');
  const requesterDid = detailString(detail, 'requesterDid', '—');
  return (
    <div className="space-y-1 text-sm text-gray-200">
      <p>Mint a new vault-native service key.</p>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Purpose</span>{purpose}
      </div>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Delivered to</span>
        <span className="font-mono">{requesterDid}</span>
      </div>
    </div>
  );
}

function renderVaultGrantDetail(approval: OperatorApprovalCard): ReactNode {
  const { detail } = approval;
  const did = detailString(detail, 'did', '—');
  const grantedTo = detailString(detail, 'grantedTo', '—');
  const purpose = detailString(detail, 'purpose', '');
  const oneTime = detail?.oneTime === true;
  return (
    <div className="space-y-1 text-sm text-gray-200">
      <p>Grant an additional consumer access to an existing vault key.</p>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Key</span><span className="font-mono">{did}</span></div>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Grant to</span><span className="font-mono">{grantedTo}</span></div>
      {purpose && <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Purpose</span>{purpose}</div>}
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">One-time</span>{oneTime ? 'yes' : 'no'}</div>
    </div>
  );
}

function renderVaultRotateDetail(approval: OperatorApprovalCard): ReactNode {
  const did = detailString(approval.detail, 'did', '—');
  return (
    <div className="space-y-1 text-sm text-gray-200">
      <p>Rotate a vault key: mint a replacement, grant its current consumer, then revoke the old key — as one signed proposal.</p>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Key</span><span className="font-mono">{did}</span></div>
    </div>
  );
}

function renderVaultRevokeDetail(approval: OperatorApprovalCard): ReactNode {
  const did = detailString(approval.detail, 'did', '—');
  const tier = detailString(approval.detail, 'tier', 'withdraw');
  return (
    <div className="space-y-2 text-sm text-gray-200">
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Key</span><span className="font-mono">{did}</span></div>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Tier</span>{revokeTierLabel(tier)}</div>
      {tier === 'destroy' && (
        <p className="text-xs text-red-300 bg-red-950/40 border border-red-900/60 rounded p-2">
          Destroy is irreversible. The key&apos;s wrapped material is erased and no future fetch will ever succeed again — this cannot be undone by re-approving.
        </p>
      )}
    </div>
  );
}

function renderVaultDetail(approval: OperatorApprovalCard): ReactNode {
  switch (approval.kind) {
    case 'vault:mint':
      return renderVaultMintDetail(approval);
    case 'vault:grant':
      return renderVaultGrantDetail(approval);
    case 'vault:rotate':
      return renderVaultRotateDetail(approval);
    case 'vault:revoke':
      return renderVaultRevokeDetail(approval);
    default:
      return renderDefaultDetail(approval);
  }
}

const VAULT_RENDERER: SourceRenderer = {
  decisionLabels: (approval) => {
    if (approval.kind === 'vault:revoke') {
      return { approve: revokeTierLabel(detailString(approval.detail, 'tier', 'withdraw')), reject: 'Cancel' };
    }
    return { approve: 'Sign', reject: 'Deny' };
  },
  renderDetail: renderVaultDetail,
};

// `access` (#2252): delegate-grant bearer knocks ("Muse Code wants to
// connect") — approving mints the bearer server-side; the one-time
// plaintext reveal is handled by `handleDecide` below, not by this
// renderer (the renderer only ever sees the durable card fields, never the
// secret).
function renderAccessDetail(approval: OperatorApprovalCard): ReactNode {
  const { detail } = approval;
  const clientLabel = detailString(detail, 'clientLabel', 'Unknown client');
  const purpose = detailString(detail, 'purpose', '\u2014');
  const scopes = Array.isArray(detail?.scopes) ? (detail.scopes as string[]) : [];
  const surfaces = Array.isArray(detail?.surfaces) ? (detail.surfaces as string[]) : [];
  return (
    <div className="space-y-1 text-sm text-gray-200">
      <p><span className="font-medium text-gray-100">{clientLabel}</span> wants a scoped bearer.</p>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Purpose</span>{purpose}</div>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Scopes</span><span className="font-mono">{scopes.join(', ') || '\u2014'}</span></div>
      <div className="text-xs text-gray-500"><span className="uppercase tracking-wide mr-2">Surfaces</span><span className="font-mono">{surfaces.join(', ') || '\u2014'}</span></div>
    </div>
  );
}

const ACCESS_RENDERER: SourceRenderer = {
  decisionLabels: { approve: 'Approve & mint bearer', reject: 'Deny' },
  renderDetail: renderAccessDetail,
};

// `github` (#2293): folds the retired pre-#2059 GitHub confirm rail
// (`/github/api/confirm/:proposalId`) into this rail. `detail` carries the
// legacy fields (tool/target/riskTier/argsSummary/ownerDid/agentDid);
// `outcome.approvedUntil` (set once decided, see
// `../../src/lib/github/approvals-execution.ts`) is null for a single-call
// approval and an ISO timestamp for a windowed one. Unlike every other
// registered source, github needs MORE than two pending-state buttons (the
// TTL choice), so it supplies `renderPendingActions` instead of relying on
// the default two-button row.
function GithubDetailView({ approval }: Readonly<{ approval: OperatorApprovalCard }>) {
  const { detail, outcome, status } = approval;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (status !== 'approved') return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  const tool = detailString(detail, 'tool', 'unknown tool');
  const target = detailString(detail, 'target', '\u2014');
  const riskTier = detailString(detail, 'riskTier', '\u2014');
  const argsSummary = detailString(detail, 'argsSummary', approval.summary);

  const approvedUntilRaw = outcome?.approvedUntil;
  const isSingleCall = status === 'approved' && approvedUntilRaw === null;
  const approvedUntilMs = typeof approvedUntilRaw === 'string' ? Date.parse(approvedUntilRaw) : NaN;
  const countdown = status === 'approved' && !Number.isNaN(approvedUntilMs) ? formatExpiryCountdown(approvedUntilMs, nowMs) : '';

  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-200 font-mono">{argsSummary}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-mono">{tool}</span>
        <span>target: <span className="font-mono text-gray-400">{target}</span></span>
        <span className={riskTier === 'mutate' ? 'text-orange-400' : 'text-blue-400'}>{riskTier}</span>
        {isSingleCall && <span>single-call approval \u2014 consumed on next write</span>}
        {countdown && <span className={countdown === 'expired' ? 'text-red-400 font-medium' : 'text-gray-500'}>{countdown}</span>}
      </div>
    </div>
  );
}

/** No / Yes / 5m / 24h \u2014 reproduces the retired legacy rail's TTL picker exactly (single-call vs. a 5-minute or 24-hour approval window covering further same-tier writes). */
function renderGithubPendingActions(
  approval: OperatorApprovalCard,
  onDecide: (approval: OperatorApprovalCard, decision: DecisionAction, mode?: string) => void,
  busy: boolean,
): ReactNode {
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <button
        type="button"
        onClick={() => onDecide(approval, 'reject')}
        disabled={busy}
        className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        No
      </button>
      <button
        type="button"
        onClick={() => onDecide(approval, 'approve', 'single')}
        disabled={busy}
        className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ring-1 ring-green-500/50"
      >
        {busy ? '\u2026' : 'Yes'}
      </button>
      <button
        type="button"
        onClick={() => onDecide(approval, 'approve', '5m')}
        disabled={busy}
        className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        5m
      </button>
      <button
        type="button"
        onClick={() => onDecide(approval, 'approve', '24h')}
        disabled={busy}
        className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        24h
      </button>
    </div>
  );
}

const GITHUB_RENDERER: SourceRenderer = {
  decisionLabels: { approve: 'Yes', reject: 'No' },
  renderDetail: (approval) => <GithubDetailView approval={approval} />,
  renderPendingActions: renderGithubPendingActions,
};

const SOURCE_RENDERERS: Readonly<Record<string, SourceRenderer>> = {
  'skill-workshop': SKILL_WORKSHOP_RENDERER,
  'gateway-exec': GATEWAY_EXEC_RENDERER,
  vault: VAULT_RENDERER,
  access: ACCESS_RENDERER,
  github: GITHUB_RENDERER,
};

function rendererFor(source: string): SourceRenderer {
  return SOURCE_RENDERERS[source] ?? DEFAULT_RENDERER;
}

// ── one-time bearer reveal (#2252) ──────────────────────────────────────────
// The decision route surfaces the freshly minted delegate-grant bearer
// plaintext exactly once, in the approve response's `data.bearer` — never
// persisted, never fetchable again (see `src/lib/access/delegate-grant.ts`).
// This box is the only place in the UI that ever holds it, in memory, until
// the operator dismisses it or navigates away.

interface RevealedBearer {
  proposalId: string;
  clientLabel: string;
  bearer: string;
  expiresAt: string;
}

function RevealedBearerBanner({
  revealed,
  onDismiss,
}: Readonly<{ revealed: RevealedBearer; onDismiss: () => void }>) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(revealed.bearer).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }, [revealed.bearer]);

  return (
    <div className="mb-4 rounded-lg border border-amber-700 bg-amber-950/40 p-4 space-y-2" data-testid="revealed-bearer">
      <p className="text-sm text-amber-200 font-medium">
        Bearer minted for &quot;{revealed.clientLabel}&quot; — shown once, never again. Paste it into the client&apos;s credential store now.
      </p>
      <pre className="text-xs font-mono text-amber-100 bg-black/40 rounded p-2 overflow-x-auto select-all">{revealed.bearer}</pre>
      <p className="text-xs text-amber-400">Sliding expiry — extends on every use, dead by {new Date(revealed.expiresAt).toLocaleString()} without one.</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={copy} className="px-2.5 py-1 rounded text-xs font-medium bg-amber-800/60 text-amber-100 hover:bg-amber-700/60">
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss} className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600">
          I&apos;ve saved it — dismiss
        </button>
      </div>
    </div>
  );
}

/** Deep-link anchor id (#2291) — the web-push notificationclick handler opens `/jin?proposalId=<id>` to this card. */
function approvalCardAnchorId(proposalId: string): string {
  return `approval-${proposalId}`;
}

function ApprovalCardRow({
  approval,
  onDecide,
  busy,
  highlighted,
}: Readonly<{
  approval: OperatorApprovalCard;
  onDecide: (approval: OperatorApprovalCard, decision: DecisionAction, mode?: string) => void;
  busy: boolean;
  /** True when this card is the one the operator was deep-linked to from a phone push (#2291). */
  highlighted: boolean;
}>) {
  const renderer = rendererFor(approval.source);
  const decisionLabels = resolveDecisionLabels(renderer, approval);
  // S9379: an imperative focus-on-mount ref instead of the declarative
  // `autoFocus` JSX attribute — same one-time focus behavior, no new SonarCloud
  // finding. Stable across renders so it only fires when the button mounts.
  const autoFocusRef = useCallback((el: HTMLButtonElement | null) => el?.focus(), []);
  // #2221: a pending approval past its own detail.expiresAt can no longer be
  // decided — the kernel enforces this authoritatively at decide time; this
  // only keeps the card from ever offering a decision it will just refuse.
  const expired = approval.status === 'pending' && isApprovalExpired(approval);
  const highlightClass = highlighted ? ' ring-2 ring-amber-500/70' : '';
  return (
    <div id={approvalCardAnchorId(approval.proposalId)} className={`rounded-lg border border-gray-800 p-4 space-y-2${highlightClass}`}>
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
      {approval.status === 'pending' && expired && (
        <div className="pt-1">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-500">expired — can no longer be decided</span>
        </div>
      )}
      {approval.status === 'pending' && !expired && (
        renderer.renderPendingActions ? renderer.renderPendingActions(approval, onDecide, busy) : (
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => onDecide(approval, 'reject')}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {decisionLabels.reject}
            </button>
            <button
              type="button"
              onClick={() => onDecide(approval, 'approve')}
              disabled={busy}
              ref={autoFocusRef}
              className="px-3 py-1.5 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ring-1 ring-green-500/50"
            >
              {busy ? '…' : decisionLabels.approve}
            </button>
          </div>
        )
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
  onDecide: (approval: OperatorApprovalCard, decision: DecisionAction, mode?: string) => void,
  busyId: string,
  deepLinkedProposalId: string | null,
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
          highlighted={deepLinkedProposalId === approval.proposalId}
        />
      ))}
    </div>
  );
}

function OperatorApprovalsPanelInner() {
  // #2291: the phone push notificationclick handler opens `/jin?proposalId=<id>`
  // — this is the "Inbox lane" deep link. Read once per navigation; the panel
  // never rewrites the URL itself.
  const searchParams = useSearchParams();
  const deepLinkedProposalId = searchParams.get('proposalId');
  const hasScrolledToDeepLink = useRef(false);

  const [isOperator, setIsOperator] = useState(false);
  const [approvals, setApprovals] = useState<OperatorApprovalCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [flash, setFlash] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [revealedBearer, setRevealedBearer] = useState<RevealedBearer | null>(null);
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

  // #2291: once the deep-linked proposal has actually loaded, scroll its
  // card into view exactly once — not on every silent poll refresh.
  useEffect(() => {
    if (!deepLinkedProposalId || hasScrolledToDeepLink.current) return;
    if (!approvals.some((approval) => approval.proposalId === deepLinkedProposalId)) return;
    const el = globalThis.document.getElementById(approvalCardAnchorId(deepLinkedProposalId));
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      hasScrolledToDeepLink.current = true;
    }
  }, [approvals, deepLinkedProposalId]);

  const handleDecide = useCallback(async (approval: OperatorApprovalCard, decision: DecisionAction, mode?: string) => {
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
        body: JSON.stringify({
          decision,
          ...(mode ? { mode } : {}),
          ...(operatorSignature ? { decidedAt, operatorSignature } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Decision failed (${res.status})`);
        return;
      }
      // #2252: an approved access:bearer-grant proposal returns the freshly
      // minted bearer plaintext exactly once, in `data.bearer` — surface it
      // as a persistent (not auto-dismissing) reveal box rather than the
      // 4s flash, since the operator needs time to copy it.
      const responseBody = await res.json().catch(() => ({})) as { data?: { bearer?: string; expiresAt?: string } };
      if (decision === 'approve' && responseBody.data?.bearer) {
        setRevealedBearer({
          proposalId,
          clientLabel: detailString(approval.detail, 'clientLabel', approval.summary),
          bearer: responseBody.data.bearer,
          expiresAt: responseBody.data.expiresAt ?? '',
        });
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

      {revealedBearer && (
        <RevealedBearerBanner revealed={revealedBearer} onDismiss={() => setRevealedBearer(null)} />
      )}

      {renderPanelBody(loading, approvals, handleDecide, busyId, deepLinkedProposalId)}
    </section>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary in the App Router — same
 * pattern `UsageFeedPanel` already uses (`usage-feed-panel.tsx`). The
 * fallback never shows in practice for this panel (search params resolve
 * synchronously on the client), but the boundary is required regardless.
 */
export function OperatorApprovalsPanel() {
  return (
    <Suspense fallback={null}>
      <OperatorApprovalsPanelInner />
    </Suspense>
  );
}
