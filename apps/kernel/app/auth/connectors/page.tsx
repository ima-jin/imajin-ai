'use client';

/**
 * /auth/connectors — Connections landing (#1494 + #1495).
 *
 * Registry-driven grid: every connector in CONNECTOR_REGISTRY gets a compact
 * card (icon + name + short description + a Connected / Not connected pill).
 * Clicking a card navigates to the per-connector detail view at
 * /auth/connectors/[id], where the configure / scope-grant / disconnect UI
 * lives (see components/ConnectorDetail.tsx).
 *
 * Adding a connector stays "registry entry + backend route" — the grid and the
 * detail route both project CONNECTOR_REGISTRY, so no page rewrite is needed
 * (#1354 invariant preserved).
 *
 * Status-pill invariant: cards fetch each connector's statusEndpoint but only
 * ever render a boolean connected/not-connected — no credentials, scopes, or
 * config values leak into the grid.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CONNECTOR_REGISTRY,
  type ConnectorEntry,
} from '@/src/lib/kernel/connector-registry';
import {
  credentialSealed,
  type CredentialSealedFlags,
} from '@/src/lib/kernel/connector-card-kind';

// ── Status pill ────────────────────────────────────────────────────────────

/**
 * Minimal, booleans-only shape of a connector scope-manifest status response.
 * Every connector endpoint returns `activeScopes`; credential-bearing connectors
 * additionally return a sealed boolean under one of the names in
 * `CredentialSealedFlags`. We read nothing else — no scope names or config values
 * are surfaced on the grid.
 */
interface GridStatus extends CredentialSealedFlags {
  activeScopes?: string[];
}

type PillState = 'loading' | 'connected' | 'disconnected' | 'error' | 'pending';

/**
 * Derive the connected boolean for a connector from its status payload:
 *   - native → at least one active scope (there is no credential to seal)
 *   - everything else → a sealed credential
 *
 * The sealed boolean is normalised (#1604): Discord reports `tokenSealed`, Gemini
 * `keySealed`, and static-secret connectors `secretSealed`, so reading only
 * `tokenSealed` showed Gemini and Warp as "Not connected" with a key sealed.
 */
function deriveConnected(entry: ConnectorEntry, status: GridStatus): boolean {
  if (entry.ingestionPattern === 'native') {
    return (status.activeScopes?.length ?? 0) > 0;
  }
  return credentialSealed(status);
}

function StatusPill({ state }: Readonly<{ state: PillState }>) {
  const map: Record<PillState, { label: string; classes: string }> = {
    loading: { label: 'Checking…', classes: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
    connected: { label: '● Connected', classes: 'bg-green-500/10 text-green-400 border-green-500/30' },
    disconnected: { label: '○ Not connected', classes: 'bg-white/5 text-gray-500 border-white/10' },
    error: { label: 'Unavailable', classes: 'bg-white/5 text-gray-500 border-white/10' },
    pending: { label: 'Coming soon', classes: 'bg-white/5 text-gray-500 border-white/10' },
  };
  const { label, classes } = map[state];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${classes}`}>
      {label}
    </span>
  );
}

// ── Grid card ─────────────────────────────────────────────────────────────────

function ConnectorGridCard({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [state, setState] = useState<PillState>(entry.backendPending ? 'pending' : 'loading');

  useEffect(() => {
    // Backend-pending connectors have no status endpoint — nothing to fetch.
    if (entry.backendPending || !entry.statusEndpoint) return;

    let cancelled = false;
    fetch(entry.statusEndpoint)
      .then((r) => (r.ok ? r.json() as Promise<GridStatus> : Promise.reject(new Error(String(r.status)))))
      .then((status) => {
        if (cancelled) return;
        setState(deriveConnected(entry, status) ? 'connected' : 'disconnected');
      })
      .catch(() => { if (!cancelled) setState('error'); });

    return () => { cancelled = true; };
  }, [entry]);

  return (
    <Link
      href={`/auth/connectors/${entry.id}`}
      className="group flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl p-5 hover:border-amber-500/40 hover:bg-white/[0.07] transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-3xl">{entry.icon}</span>
        <StatusPill state={state} />
      </div>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-white group-hover:text-amber-400 transition-colors">
          {entry.name}
        </h2>
        <p className="text-sm text-gray-400 mt-0.5 line-clamp-2">{entry.description}</p>
      </div>
    </Link>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  // Auth is handled server-side by the auth layout. We do a lightweight
  // client check so the page can show a loading state while it resolves, and
  // handle the unauthenticated edge case gracefully.
  const [sessionLoading, setSessionLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    fetch('/auth/api/session')
      .then((r) => { setIsLoggedIn(r.ok); setSessionLoading(false); })
      .catch(() => { setIsLoggedIn(false); setSessionLoading(false); });
  }, []);

  if (sessionLoading) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-gray-400">
        Loading…
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">🔌</div>
        <h1 className="text-3xl font-bold mb-3">Connections</h1>
        <p className="text-gray-400 mb-8">Sign in to connect your tools.</p>
        <a
          href="/auth/login"
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Connections</h1>
          <p className="text-gray-400 text-sm mt-1">
            Connect your tools to let AI act on your behalf.
          </p>
        </div>
        <a
          href="/auth"
          className="text-sm text-gray-500 hover:text-gray-300 transition"
        >
          ← Account
        </a>
      </div>

      {/* Connector grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {CONNECTOR_REGISTRY.map((entry) => (
          <ConnectorGridCard key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
