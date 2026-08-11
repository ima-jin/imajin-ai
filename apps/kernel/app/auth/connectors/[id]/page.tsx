'use client';

import { use } from 'react';

/**
 * /auth/connectors/[id] — per-connector detail view (#1494).
 *
 * The connectors landing (/auth/connectors) is a registry-driven grid; clicking
 * a card lands here. This route resolves the connector by id from
 * CONNECTOR_REGISTRY and renders the configure / scope-grant / disconnect UI
 * (ConnectorDetail). Unknown ids render a not-found state.
 */

import Link from 'next/link';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../components/ConnectorDetail';
import { ConnectorUsage } from '../components/ConnectorUsage';

export default function ConnectorDetailPage(props: Readonly<{ params: Promise<{ id: string }> }>) {
  const params = use(props.params);
  const { id } = params;
  const entry = getConnector(id);

  if (!entry) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">🔌</div>
        <h1 className="text-2xl font-bold text-white mb-3">Connector not found</h1>
        <p className="text-gray-400 mb-8">
          We couldn&apos;t find a connector named <code className="font-mono">{id}</code>.
        </p>
        <Link
          href="/auth/connectors"
          className="inline-block px-6 py-2.5 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          ← Back to Connections
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link
          href="/auth/connectors"
          className="text-sm text-gray-500 hover:text-gray-300 transition"
        >
          ← Connections
        </Link>
      </div>

      <ConnectorDetail entry={entry} />

      {/* Usage rollup (#1799) — attestations + signed connector actions, scoped
          to this connector's registered scope(s). Renders nothing until the
          fetch resolves, and nothing at all on error, so it never blocks or
          clutters the connect/scope/disconnect flow above. */}
      <ConnectorUsage entry={entry} />

      {/* Consent note — grant-by-edit applies to on-consent scopes below. */}
      <p className="text-center text-xs text-gray-700 mt-8">
        On-consent scopes (<code className="font-mono">:write</code>, <code className="font-mono">github:org</code>, <code className="font-mono">discord:*</code>) use grant-by-edit consent — toggling them here writes the consent row automatically.
      </p>
    </div>
  );
}
