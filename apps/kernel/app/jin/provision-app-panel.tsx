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
import { approvalCardAnchorId } from './approval-anchor';
import {
  DEFAULT_APP_TEMPLATE,
  buildProvisionPayload,
  hasProvisionErrors,
  validateProvisionForm,
  type ProvisionFormErrors,
  type ProvisionFormValues,
} from './provision-app-validation';
import { useFlashNotice } from './use-flash-notice';

const POLL_INTERVAL_MS = 5000;

/** Row shape of `GET /api/apps/provision?slug=` (the subset this panel shows). */
interface ProvisionLedger {
  slug: string;
  status: 'pending' | 'succeeded' | 'failed';
  appDid: string | null;
  repoUrl: string | null;
  failedStep: string | null;
  errorMessage: string | null;
}

type TrackedOutcome =
  | { phase: 'awaiting-approval' }
  | { phase: 'declined'; status: string }
  | { phase: 'running' }
  | { phase: 'succeeded'; ledger: ProvisionLedger }
  | { phase: 'failed'; ledger: ProvisionLedger };

/** The proposal (or already-provisioned slug) the result block is following. */
interface TrackedProposal {
  slug: string;
  /** Null when the slug was already provisioned — nothing was proposed. */
  proposalId: string | null;
  /** True when the route reused an existing pending proposal (200) instead of raising a new one (201). */
  alreadyPending: boolean;
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
  return outcome?.phase === 'succeeded' || outcome?.phase === 'failed' || outcome?.phase === 'declined';
}

/** Status of one approvals card, or null when it can't be read / isn't listed. */
async function fetchCardStatus(proposalId: string): Promise<string | null> {
  try {
    const res = await fetch('/jin/api/operator-approvals', { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { approvals?: Array<{ proposalId: string; status: string }> };
    const card = (data.approvals ?? []).find((approval) => approval.proposalId === proposalId);
    return card?.status ?? null;
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

async function resolveOutcome(slug: string, proposalId: string): Promise<TrackedOutcome> {
  const cardStatus = await fetchCardStatus(proposalId);
  if (cardStatus === 'pending') return { phase: 'awaiting-approval' };
  if (cardStatus && DECLINED_STATUSES.has(cardStatus)) return { phase: 'declined', status: cardStatus };

  const ledger = await fetchLedger(slug);
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

function OutcomeDetails({ outcome, slug }: Readonly<{ outcome: TrackedOutcome; slug: string }>) {
  if (outcome.phase === 'succeeded') {
    const { ledger } = outcome;
    return (
      <>
        <p className="text-xs font-medium text-green-300">Provisioned — {slug} succeeded.</p>
        <dl className="space-y-1">
          <ResultRow label="status">{ledger.status}</ResultRow>
          <ResultRow label="repoUrl">
            {ledger.repoUrl ? (
              <a href={ledger.repoUrl} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">
                {ledger.repoUrl}
              </a>
            ) : (
              '—'
            )}
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
    return <p className="text-xs text-gray-400">The proposal was {outcome.status}. Nothing was provisioned.</p>;
  }
  if (outcome.phase === 'running') {
    return <p className="text-xs text-gray-400">Approved — provisioning {slug}…</p>;
  }
  return <p className="text-xs text-gray-400">Waiting for your approval below.</p>;
}

function ProposalResult({ tracked, outcome }: Readonly<{ tracked: TrackedProposal; outcome: TrackedOutcome }>) {
  const { slug, proposalId, alreadyPending } = tracked;
  let headline = 'Already provisioned';
  if (proposalId) {
    headline = alreadyPending ? 'Already pending' : 'Proposal raised';
  }
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
  const done = isTerminal(outcome);
  useEffect(() => {
    if (!trackedSlug || !trackedProposalId || done) return undefined;
    let cancelled = false;
    const tick = async () => {
      const next = await resolveOutcome(trackedSlug, trackedProposalId);
      if (!cancelled) setOutcome(next);
    };
    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trackedSlug, trackedProposalId, done]);

  const setField = (field: keyof ProvisionFormValues) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const applyResponse = (slug: string, status: number, body: ProvisionResponse) => {
    if (body.status === 'succeeded') {
      setTracked({ slug, proposalId: null, alreadyPending: false });
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
      setTracked({ slug, proposalId: body.proposalId, alreadyPending: status === 200 });
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
      applyResponse(payload.slug, res.status, body);
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

      {tracked && outcome && <ProposalResult tracked={tracked} outcome={outcome} />}
    </section>
  );
}
