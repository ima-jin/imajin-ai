'use client';

/**
 * "Provision app" form on `/jin` (#2559) — the operator's seat for proposing
 * `apps.provision` (#2375) without a browser-console `fetch` or a curl with a
 * copied session cookie.
 *
 * This panel adds NO endpoint and NO authority. Submitting calls the existing
 * `POST /api/apps/provision`, which only ever creates a PENDING proposal on
 * the operator-approvals rail; approving it stays a countersigned decision on
 * the existing `OperatorApprovalsPanel` card rendered right below this panel.
 * After the decision, the result is read back from the existing
 * `GET /api/apps/provision?slug=` (and the card's own status from the existing
 * `GET /jin/api/operator-approvals`), so the operator never polls by hand.
 *
 * Visible only to the node operator (`isOperator` from the approvals list
 * route) — non-operators see nothing, matching the rest of the console.
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { approvalCardAnchorId, requestApprovalsRefresh } from './approval-anchor';
import { proposeClaimReissue } from './provision-reissue';
import {
  DEFAULT_APP_TEMPLATE,
  buildProvisionPayload,
  hasProvisionErrors,
  isGithubRepoUrl,
  isLedgerNewerThanDecision,
  isPendingCardExpired,
  validateProvisionForm,
  type ProvisionFormErrors,
  type ProvisionFormValues,
} from './provision-app-validation';
import { useFlashNotice } from './use-flash-notice';

const POLL_INTERVAL_MS = 5000;
/** Provision proposals live on the `apps` source — scope the poll to it. */
const APPROVALS_URL = '/jin/api/operator-approvals?source=apps';

/** Row shape of `GET /api/apps/provision?slug=` (the subset this panel shows). */
interface ProvisionLedger {
  slug: string;
  status: 'pending' | 'succeeded' | 'failed';
  appDid: string | null;
  repoUrl: string | null;
  failedStep: string | null;
  errorMessage: string | null;
  /** ISO timestamp of the row's last write — used to tell this run from a previous one for the same slug. */
  updatedAt?: string;
}

/** The subset of one approvals card this panel reads. */
interface CardSnapshot {
  status: string;
  /** When the operator decided the card, if they have. */
  decidedAt: string | null;
}

type TrackedOutcome =
  | { phase: 'awaiting-approval' }
  | { phase: 'declined'; status: string }
  | { phase: 'running' }
  /** #2707: a claim-code reissue was approved — the code itself shows once, in the approvals card's amber box. */
  | { phase: 'reissued' }
  | { phase: 'succeeded'; ledger: ProvisionLedger }
  | { phase: 'failed'; ledger: ProvisionLedger };

/** The proposal (or already-provisioned slug) the result block is following. */
interface TrackedProposal {
  slug: string;
  /** Needed to raise a claim-code reissue (#2707) — the route requires it. */
  displayName: string;
  /** Null when the slug was already provisioned — nothing was proposed. */
  proposalId: string | null;
  /** True when the route reused an existing pending proposal (200) instead of raising a new one (201). */
  alreadyPending: boolean;
  /** True when `proposalId` is a claim-code reissue (#2707), not a provision run. */
  reissue?: boolean;
}

interface ProvisionResponse {
  status?: string;
  proposalId?: string;
  slug?: string;
  appDid?: string | null;
  repoUrl?: string | null;
  error?: string;
}

const DECLINED_STATUSES: ReadonlySet<string> = new Set(['denied', 'withdrawn', 'expired']);

const EMPTY_VALUES: ProvisionFormValues = {
  slug: '',
  displayName: '',
  template: DEFAULT_APP_TEMPLATE,
  attestationTypes: '',
};

function isTerminal(outcome: TrackedOutcome | null): boolean {
  return outcome?.phase === 'succeeded' || outcome?.phase === 'failed' || outcome?.phase === 'declined' || outcome?.phase === 'reissued';
}

interface ApprovalCardRow {
  proposalId: string;
  status: string;
  detail?: Record<string, unknown> | null;
  decision?: { decidedAt?: string } | null;
}

/**
 * State of one approvals card, or null when it can't be read / isn't listed.
 * Scoped to `source=apps` (the provision proposals' source) so the 5 s poll
 * never pulls the operator's whole approvals queue. A still-`pending` card
 * past its `detail.expiresAt` is reported as `expired`, because the list route
 * never does.
 */
async function fetchCard(proposalId: string): Promise<CardSnapshot | null> {
  try {
    const res = await fetch(APPROVALS_URL, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { approvals?: ApprovalCardRow[] };
    const card = (data.approvals ?? []).find((approval) => approval.proposalId === proposalId);
    if (!card) return null;
    if (card.status === 'pending' && isPendingCardExpired(card.detail, Date.now())) {
      return { status: 'expired', decidedAt: null };
    }
    return { status: card.status, decidedAt: card.decision?.decidedAt ?? null };
  } catch {
    return null;
  }
}

/** Ledger row for `slug`, or null while no run exists yet (404) or on a transient error. */
async function fetchLedger(slug: string): Promise<ProvisionLedger | null> {
  try {
    const res = await fetch(`/api/apps/provision?slug=${encodeURIComponent(slug)}`, { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as ProvisionLedger;
  } catch {
    return null;
  }
}

async function resolveOutcome(slug: string, proposalId: string, reissue = false): Promise<TrackedOutcome> {
  const card = await fetchCard(proposalId);
  const cardStatus = card?.status;
  if (cardStatus === 'pending') return { phase: 'awaiting-approval' };
  if (cardStatus && DECLINED_STATUSES.has(cardStatus)) return { phase: 'declined', status: cardStatus };
  // #2707: a reissue leaves the ledger row untouched (nothing is re-created), so there is no
  // newer ledger row to wait for — an approved card IS the end of it.
  if (reissue) return cardStatus ? { phase: 'reissued' } : { phase: 'awaiting-approval' };

  // A ledger row last written before the card was decided belongs to an
  // earlier run of this slug (e.g. a prior failure) — not this proposal's result.
  const fetched = await fetchLedger(slug);
  const ledger = fetched && isLedgerNewerThanDecision(fetched.updatedAt, card?.decidedAt) ? fetched : null;
  if (ledger?.status === 'succeeded') return { phase: 'succeeded', ledger };
  if (ledger?.status === 'failed') return { phase: 'failed', ledger };
  if (ledger?.status === 'pending' || cardStatus) return { phase: 'running' };
  return { phase: 'awaiting-approval' };
}

function FieldError({ id, message }: Readonly<{ id: string; message?: string }>) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-red-300">
      {message}
    </p>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  placeholder,
  hint,
  required,
  disabled,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}>) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-xs text-gray-400">
        {label}
        {required && <span className="text-red-400"> *</span>}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 disabled:opacity-40"
      />
      {hint && <p className="text-xs text-gray-600">{hint}</p>}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function ResultRow({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex gap-2 text-xs">
      <dt className="w-24 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-gray-200">{children}</dd>
    </div>
  );
}

/** Link only for a `https://github.com/` URL; any other value is shown as inert text. */
function renderRepoUrl(url: string | null): ReactNode {
  if (!url) return '—';
  if (!isGithubRepoUrl(url)) return url;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">
      {url}
    </a>
  );
}

function OutcomeDetails({ outcome, slug }: Readonly<{ outcome: TrackedOutcome; slug: string }>) {
  if (outcome.phase === 'reissued') {
    return (
      <p className="text-xs font-medium text-green-300">
        Reissue approved — the one-time claim code for {slug} is in the amber box in Operator approvals below.
      </p>
    );
  }
  if (outcome.phase === 'succeeded') {
    const { ledger } = outcome;
    return (
      <>
        <p className="text-xs font-medium text-green-300">Provisioned — {slug} succeeded.</p>
        <dl className="space-y-1">
          <ResultRow label="status">{ledger.status}</ResultRow>
          <ResultRow label="repoUrl">
            {renderRepoUrl(ledger.repoUrl)}
          </ResultRow>
          <ResultRow label="appDid">{ledger.appDid ?? '—'}</ResultRow>
        </dl>
      </>
    );
  }
  if (outcome.phase === 'failed') {
    const { ledger } = outcome;
    return (
      <>
        <p className="text-xs font-medium text-red-300">Provisioning failed for {slug}.</p>
        <dl className="space-y-1">
          <ResultRow label="status">{ledger.status}</ResultRow>
          <ResultRow label="failedStep">{ledger.failedStep ?? '—'}</ResultRow>
          <ResultRow label="errorMessage">{ledger.errorMessage ?? '—'}</ResultRow>
        </dl>
      </>
    );
  }
  if (outcome.phase === 'declined') {
    const was = outcome.status === 'expired' ? 'expired' : `was ${outcome.status}`;
    return <p className="text-xs text-gray-400">The proposal {was}. Nothing was provisioned.</p>;
  }
  if (outcome.phase === 'running') {
    return <p className="text-xs text-gray-400">Approved — provisioning {slug}…</p>;
  }
  return <p className="text-xs text-gray-400">Waiting for your approval below.</p>;
}

function ProposalResult({
  tracked,
  outcome,
  reissueBusy,
  onReissue,
}: Readonly<{ tracked: TrackedProposal; outcome: TrackedOutcome; reissueBusy: boolean; onReissue: () => void }>) {
  const { slug, proposalId, alreadyPending, reissue } = tracked;
  let headline = 'Already provisioned';
  if (proposalId) {
    headline = alreadyPending ? 'Already pending' : 'Proposal raised';
  }
  // #2707: only an app that is actually provisioned (or whose reissue just landed) can have a code reissued.
  const canReissue = outcome.phase === 'succeeded' || outcome.phase === 'reissued';
  if (reissue) headline = alreadyPending ? 'Reissue already pending' : 'Reissue proposed';
  return (
    <div
      className="mt-3 rounded-lg border border-gray-800 p-3 space-y-2"
      data-testid="provision-result"
      data-phase={outcome.phase}
      aria-live="polite"
    >
      <p className="text-xs text-gray-300">
        <span className="font-medium">{headline}</span>
        <span className="ml-2 font-mono text-gray-500">{slug}</span>
      </p>
      {proposalId && (
        <p className="text-xs text-gray-500">
          proposalId <span className="font-mono text-gray-300" data-testid="provision-proposal-id">{proposalId}</span>
          {' — '}
          <a href={`#${approvalCardAnchorId(proposalId)}`} className="text-amber-400 hover:underline">
            review it in Operator approvals below
          </a>
        </p>
      )}
      <OutcomeDetails outcome={outcome} slug={slug} />
      {canReissue && (
        <button
          type="button"
          onClick={onReissue}
          disabled={reissueBusy}
          data-testid="provision-reissue"
          className="px-2.5 py-1 rounded text-xs font-medium bg-amber-800/60 text-amber-100 hover:bg-amber-700/60 disabled:opacity-40"
        >
          {reissueBusy ? 'Proposing…' : 'Reissue claim code'}
        </button>
      )}
    </div>
  );
}

export function ProvisionAppPanel() {
  const [visible, setVisible] = useState(false);
  const [values, setValues] = useState<ProvisionFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<ProvisionFormErrors>({});
  const [busy, setBusy] = useState(false);
  const [tracked, setTracked] = useState<TrackedProposal | null>(null);
  const [outcome, setOutcome] = useState<TrackedOutcome | null>(null);
  const [reissueBusy, setReissueBusy] = useState(false);

  const { flash, notify } = useFlashNotice(5000);

  // Operator-only gate: reuse the approvals list route's `isOperator` flag.
  useEffect(() => {
    let cancelled = false;
    const checkOperator = async () => {
      try {
        const res = await fetch('/jin/api/operator-approvals', { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as { isOperator?: boolean };
        if (!cancelled) setVisible(data.isOperator === true);
      } catch {
        // Silent — the form simply stays hidden on a transient network error.
      }
    };
    void checkOperator();
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow a raised proposal until it reaches a terminal outcome.
  const trackedSlug = tracked?.slug;
  const trackedProposalId = tracked?.proposalId;
  const trackedIsReissue = tracked?.reissue === true;
  const done = isTerminal(outcome);
  useEffect(() => {
    if (!trackedSlug || !trackedProposalId || done) return undefined;
    let cancelled = false;
    const tick = async () => {
      const next = await resolveOutcome(trackedSlug, trackedProposalId, trackedIsReissue);
      if (!cancelled) setOutcome(next);
    };
    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trackedSlug, trackedProposalId, trackedIsReissue, done]);

  const setField = (field: keyof ProvisionFormValues) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  // #2707: raise the existing `reissueClaim: true` proposal for the app being shown, then follow it.
  const reissueClaimCode = async () => {
    if (!tracked || reissueBusy) return;
    setReissueBusy(true);
    try {
      const result = await proposeClaimReissue({ slug: tracked.slug, displayName: tracked.displayName });
      if (!result.ok) {
        notify('err', result.error);
        return;
      }
      setTracked({
        slug: tracked.slug,
        displayName: tracked.displayName,
        proposalId: result.proposalId,
        alreadyPending: result.alreadyPending,
        reissue: true,
      });
      setOutcome({ phase: 'awaiting-approval' });
      requestApprovalsRefresh();
    } finally {
      setReissueBusy(false);
    }
  };

  const applyResponse = (slug: string, displayName: string, status: number, body: ProvisionResponse) => {
    if (body.status === 'succeeded') {
      setTracked({ slug, displayName, proposalId: null, alreadyPending: false });
      setOutcome({
        phase: 'succeeded',
        ledger: {
          slug,
          status: 'succeeded',
          appDid: body.appDid ?? null,
          repoUrl: body.repoUrl ?? null,
          failedStep: null,
          errorMessage: null,
        },
      });
      return;
    }
    if (body.status === 'pending' && body.proposalId) {
      setTracked({ slug, displayName, proposalId: body.proposalId, alreadyPending: status === 200 });
      setOutcome({ phase: 'awaiting-approval' });
      return;
    }
    notify('err', 'Unexpected response from apps.provision');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateProvisionForm(values);
    setErrors(found);
    if (hasProvisionErrors(found)) return;

    const payload = buildProvisionPayload(values);
    setBusy(true);
    try {
      const res = await fetch('/api/apps/provision', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as ProvisionResponse;
      if (!res.ok) {
        notify('err', body.error ?? `Failed to propose apps.provision (${res.status})`);
        return;
      }
      applyResponse(payload.slug, payload.displayName, res.status, body);
    } catch {
      notify('err', 'Network error — apps.provision was not proposed');
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <section className="mt-8" data-testid="provision-app-panel">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-gray-100">Provision app</h2>
        <p className="text-xs text-gray-500">
          Propose <span className="font-mono">apps.provision</span> — creates the app repo and registers it. Nothing
          happens until you approve the proposal in Operator approvals below.
        </p>
      </div>

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded text-xs font-medium ${flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
          {flash.msg}
        </div>
      )}

      <form onSubmit={submit} noValidate className="space-y-3 rounded-lg border border-gray-800 p-3">
        <TextField
          label="Slug"
          value={values.slug}
          onChange={setField('slug')}
          error={errors.slug}
          placeholder="coffee"
          required
          disabled={busy}
        />
        <TextField
          label="Display name"
          value={values.displayName}
          onChange={setField('displayName')}
          error={errors.displayName}
          placeholder="Coffee"
          required
          disabled={busy}
        />
        <TextField
          label="Template"
          value={values.template}
          onChange={setField('template')}
          error={errors.template}
          hint="Optional — defaults to the standard app template."
          disabled={busy}
        />
        <TextField
          label="Attestation types"
          value={values.attestationTypes}
          onChange={setField('attestationTypes')}
          error={errors.attestationTypes}
          placeholder="coffee/order, coffee/review"
          hint="Optional — comma-separated, each as <slug>/<type>."
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy}
          className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40"
        >
          {busy ? 'Proposing…' : 'Propose provision'}
        </button>
      </form>

      {tracked && outcome && (
        <ProposalResult tracked={tracked} outcome={outcome} reissueBusy={reissueBusy} onReissue={() => void reissueClaimCode()} />
      )}
    </section>
  );
}
