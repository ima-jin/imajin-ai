'use client';

import { useState, useEffect } from 'react';

// ─── Retrace (#1962) — read-only causal walk from any terminal artifact ────
// back to the originating signed intent. Mirrors the response contract of
// `GET /auth/api/retrace` (see apps/kernel/src/lib/retrace/types.ts).

export type RetraceArtifactKind = 'attestation' | 'agent_provision' | 'bus_event';

export interface RetraceHop {
  kind: RetraceArtifactKind;
  actorDid: string;
  onBehalfOf: string | null;
  grant: { grantId: string; capability?: string } | null;
  input: string | null;
  output: string;
  route: string;
  timestamp: string;
  signature: 'verified' | 'invalid' | 'unsigned';
}

export interface RetraceTombstone {
  kind: 'tombstone';
  timestamp: string;
  hash: string;
}

export type RetraceNode = RetraceHop | RetraceTombstone;

export interface RetraceResult {
  hops: RetraceNode[];
  terminal: { reached: boolean; ref: { kind: RetraceArtifactKind; id: string } | null; reason: string | null };
  truncated: boolean;
}

export function isTombstone(node: RetraceNode): node is RetraceTombstone {
  return node.kind === 'tombstone';
}

const SIGNATURE_STYLES: Record<RetraceHop['signature'], string> = {
  verified: 'border-green-700 text-green-400 bg-green-900/20',
  invalid: 'border-red-800 text-red-400 bg-red-900/20',
  unsigned: 'border-gray-700 text-gray-500 bg-gray-900/20',
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** One expandable hop row: actor/route summary collapsed, linked input/output + signature status expanded. */
function HopRow({ node }: Readonly<{ node: RetraceHop }>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="rounded-lg border border-gray-800 bg-gray-950 p-3 space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="px-1.5 py-0.5 text-xs rounded border border-gray-700 text-gray-400 capitalize">{node.kind.replace('_', ' ')}</span>
          <span className={`px-1.5 py-0.5 text-xs rounded border ${SIGNATURE_STYLES[node.signature]}`}>{node.signature}</span>
          <span className="text-xs text-gray-500 font-mono truncate">{node.actorDid}</span>
        </div>
        <span className="text-xs text-gray-600 shrink-0">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <div className="pt-2 border-t border-gray-900 space-y-1.5 text-xs text-gray-500">
          <p>Route: <span className="text-gray-300 font-mono">{node.route}</span></p>
          <p>Timestamp: <span className="text-gray-300">{formatDateTime(node.timestamp)}</span></p>
          {node.onBehalfOf && <p>On behalf of: <span className="text-gray-300 font-mono">{node.onBehalfOf}</span></p>}
          {node.grant && (
            <p>Grant: <span className="text-gray-300 font-mono">{node.grant.grantId}</span>{node.grant.capability ? ` (${node.grant.capability})` : ''}</p>
          )}
          <p>Output (this artifact): <span className="text-gray-300 font-mono">{node.output}</span></p>
          <p>Input (consumed): <span className="text-gray-300 font-mono">{node.input ?? '(none — originating hop)'}</span></p>
        </div>
      )}
    </li>
  );
}

/** A hop the caller isn't authorized to read: THAT it exists, never WHAT it is. */
function TombstoneRow({ node }: Readonly<{ node: RetraceTombstone }>) {
  return (
    <li className="rounded-lg border border-gray-800 bg-gray-950/60 p-3 flex items-center gap-2 text-xs text-gray-600">
      <span aria-hidden="true">🔒</span>
      <span>Hop not visible to you</span>
      <span className="font-mono text-gray-700 truncate">{node.hash.slice(0, 12)}…</span>
      <span className="ml-auto text-gray-700">{formatDateTime(node.timestamp)}</span>
    </li>
  );
}

interface RetracePaneProps {
  /** Pre-fills the artifact input, e.g. from a provision row's "Retrace" action. */
  initialArtifact?: string;
}

/**
 * "Retrace" pane (#1962): pick an outcome (any artifact id — attestation,
 * agent provision, or bus event), and walk the record backwards to the
 * originating signed intent, newest hop first.
 */
export default function RetracePane({ initialArtifact = '' }: Readonly<RetracePaneProps>) {
  const [artifact, setArtifact] = useState(initialArtifact);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RetraceResult | null>(null);

  // Auto-run once when opened from a provision row's "Retrace" action so the
  // chain appears immediately rather than requiring a second click.
  useEffect(() => {
    if (initialArtifact.trim()) {
      runRetrace(initialArtifact);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on mount, keyed by initialArtifact by the caller
  }, []);

  async function runRetrace(id: string) {
    if (!id.trim()) {
      setError('Enter an artifact id to retrace.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/auth/api/retrace?artifact=${encodeURIComponent(id.trim())}`, { credentials: 'include' });
      if (res.ok) {
        setResult(await res.json());
      } else {
        const body = await res.json().catch(() => ({}));
        setResult(null);
        setError(body.error || `Failed to retrace (status ${res.status}).`);
      }
    } catch {
      setResult(null);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
      <h2 className="text-lg font-semibold text-white mb-1">Retrace</h2>
      <p className="text-gray-400 text-sm mb-4">
        Walk the signed record backwards from any outcome to the originating wish — newest hop first.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); runRetrace(artifact); }}
        className="flex items-center gap-2 mb-4"
      >
        <input
          type="text"
          aria-label="Artifact id to retrace"
          placeholder="att_..., prov_..., or a bus event id"
          value={artifact}
          onChange={(e) => setArtifact(e.target.value)}
          className="flex-1 px-3 py-1.5 text-sm border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold rounded-lg transition disabled:opacity-50"
        >
          {loading ? 'Retracing…' : 'Retrace'}
        </button>
      </form>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      {result && (
        <div className="space-y-3">
          <ul className="space-y-2">
            {result.hops.map((node, i) =>
              // Hops carry no stable id for tombstones by design (they must not identify what they hide) — index is the only key available.
              isTombstone(node) ? <TombstoneRow key={i} node={node} /> : <HopRow key={i} node={node} />,
            )}
          </ul>
          <p className="text-xs text-gray-600">
            {result.terminal.reached
              ? `Reached the origin of this chain${result.terminal.reason ? `: ${result.terminal.reason}` : '.'}`
              : 'The chain did not terminate within the walked depth.'}
            {result.truncated && ' (truncated — max depth or a cycle was hit)'}
          </p>
        </div>
      )}
    </div>
  );
}
