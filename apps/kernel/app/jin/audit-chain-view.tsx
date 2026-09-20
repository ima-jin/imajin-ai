'use client';

/**
 * Auditor chain view (#2204) — the click-through surface the issue asks
 * for: "do we have a way for an auditor to click through and observe this
 * chain?" Renders `GET /usage/api/audit/sessions/{sessionId}` inline under
 * a session in the usage feed panel: session -> turn -> usage row ->
 * transaction -> signed attestation -> upstream request id, in one place.
 *
 * The signed attestation is embedded verbatim in the endpoint's response
 * (there is no separate "fetch attestation by id" route in this codebase
 * yet), so "linking to the signed artefact" is an inline disclosure of
 * that exact record rather than a navigation — the auditor still gets the
 * full signed payload/signature/cid for independent verification, just
 * without a second round trip.
 */
import { useEffect, useState } from 'react';
import { truncateId } from './usage-feed-grouping';

interface AuditTransaction {
  id: string;
  amount: string;
  currency: string;
  status: string;
  toDid: string;
  createdAt: string | null;
}

interface AuditAttestation {
  id: string;
  issuerDid: string;
  payload: Record<string, unknown>;
  signature: string;
  cid: string | null;
  issuedAt: string;
}

interface AuditUsageRow {
  id: string;
  source: string;
  resource: string;
  provider: string;
  connectorId: string | null;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  status: string | null;
  agentDid: string | null;
  externalId: string | null;
  createdAt: string;
  transaction: AuditTransaction | null;
  attestation: AuditAttestation | null;
}

interface AuditTurn {
  turnId: string | null;
  usage: AuditUsageRow[];
}

interface AuditSessionChain {
  sessionId: string;
  principalDid: string;
  turns: AuditTurn[];
}

function formatCost(costUsd: string | null): string {
  if (costUsd === null) return '—';
  const parsed = Number(costUsd);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(4)}` : costUsd;
}

function AttestationDisclosure({ attestation }: Readonly<{ attestation: AuditAttestation | null }>) {
  const [open, setOpen] = useState(false);
  if (!attestation) {
    return <span className="text-[11px] text-gray-600">no attestation on file</span>;
  }
  return (
    <div className="text-[11px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        {open ? '▾' : '▸'} signed record {truncateId(attestation.id)}
      </button>
      {open && (
        <pre className="mt-1 p-2 rounded bg-black/40 text-[10px] text-gray-400 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(attestation, null, 2)}
        </pre>
      )}
    </div>
  );
}

function UsageHop({ row }: Readonly<{ row: AuditUsageRow }>) {
  return (
    <div className="rounded border border-gray-800 p-3 space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-gray-300">{row.provider}/{row.model}</span>
        <span className="text-gray-400">{formatCost(row.costUsd)}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
        <span>{row.tokensIn ?? '—'} in / {row.tokensOut ?? '—'} out</span>
        {row.status && <span className="text-red-400">status: {row.status}</span>}
        <span>agent: {row.agentDid ? truncateId(row.agentDid) : '—'}</span>
      </div>
      <div className="text-[11px] text-gray-500 font-mono">
        upstream id: {row.externalId ?? '—'}
      </div>
      <div className="text-[11px] text-gray-500">
        transaction: {row.transaction ? `${truncateId(row.transaction.id)} · ${row.transaction.amount} ${row.transaction.currency}` : '—'}
      </div>
      <AttestationDisclosure attestation={row.attestation} />
    </div>
  );
}

function TurnSection({ turn }: Readonly<{ turn: AuditTurn }>) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-mono text-gray-400">turn {turn.turnId ? truncateId(turn.turnId) : '(none)'}</div>
      <div className="space-y-2 pl-3 border-l border-gray-800">
        {turn.usage.map((row) => <UsageHop key={row.id} row={row} />)}
      </div>
    </div>
  );
}

// S3358: avoid nested ternary by extracting render logic.
function renderChainBody(loading: boolean, error: string | null, chain: AuditSessionChain | null) {
  if (loading) {
    return <p className="text-xs text-gray-500 py-4 text-center">Loading chain…</p>;
  }
  if (error) {
    return <p className="text-xs text-red-400">{error}</p>;
  }
  if (!chain) {
    return null;
  }
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500">
        principal: <span className="font-mono">{truncateId(chain.principalDid)}</span>
      </p>
      {chain.turns.map((turn) => (
        <TurnSection key={turn.turnId ?? `no-turn-${chain.sessionId}-${turn.usage[0]?.id ?? ''}`} turn={turn} />
      ))}
    </div>
  );
}

export function AuditChainView({ sessionId, onClose }: Readonly<{ sessionId: string; onClose: () => void }>) {
  const [chain, setChain] = useState<AuditSessionChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/usage/api/audit/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load chain (${res.status})`);
          return;
        }
        const data = (await res.json()) as AuditSessionChain;
        setChain(data);
      })
      .catch(() => {
        if (!cancelled) setError('Network error loading chain');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="mt-2 rounded-lg border border-indigo-900/60 bg-gray-950/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-indigo-300">Audit chain · {truncateId(sessionId)}</h3>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
          close ✕
        </button>
      </div>
      {renderChainBody(loading, error, chain)}
    </div>
  );
}
