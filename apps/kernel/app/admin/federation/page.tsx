import { getClient } from '@imajin/db';
import { formatDistanceToNow } from 'date-fns';
import PeerManager from './peer-manager';

const sql = getClient();

async function getRelayWellKnown() {
  try {
    const baseUrl = process.env.REGISTRY_SERVICE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const res = await fetch(`${baseUrl}/registry/relay/.well-known/dfos-relay`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json() as {
      did: string;
      protocol: string;
      version: string;
      capabilities: Record<string, boolean>;
      profile: string;
    };
  } catch {
    return null;
  }
}

export default async function AdminFederationPage() {
  const [relayConfigRow] = await sql`
    SELECT did, imajin_did, node_fee_bps, buyer_credit_bps, created_at
    FROM relay.relay_config
    WHERE id = 'singleton'
    LIMIT 1
  `;

  const wellKnown = await getRelayWellKnown();

  const [identityChainCount] = await sql`
    SELECT COUNT(*) AS count FROM relay.relay_identity_chains
  `;
  const [contentChainCount] = await sql`
    SELECT COUNT(*) AS count FROM relay.relay_content_chains
  `;
  const [operationCount] = await sql`
    SELECT COUNT(*) AS count FROM relay.relay_operations
  `;

  const recentOps = await sql`
    SELECT cid, chain_type, chain_id, created_at
    FROM relay.relay_operations
    ORDER BY created_at DESC
    LIMIT 15
  `;

  const capabilities = wellKnown?.capabilities ?? {};

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Federation</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Relay status, peer connections, and chain statistics
        </p>
      </div>

      {/* Relay Status */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          Relay Status
        </h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">DFOS DID</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-white break-all">
              {wellKnown?.did ?? relayConfigRow?.did ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Imajin DID</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-white break-all">
              {relayConfigRow?.imajin_did ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Relay Version</dt>
            <dd className="text-sm text-gray-900 dark:text-white">
              {wellKnown
                ? `${wellKnown.protocol} ${wellKnown.version}`
                : <span className="text-gray-400 italic">unavailable</span>
              }
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Capabilities</dt>
            <dd className="flex flex-wrap gap-1.5">
              {wellKnown ? (
                Object.entries(capabilities).map(([cap, enabled]) => (
                  <span
                    key={cap}
                    className={`text-xs px-2 py-0.5 rounded font-medium ${
                      enabled
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 line-through'
                    }`}
                  >
                    {cap}
                  </span>
                ))
              ) : (
                <span className="text-sm text-gray-400 italic">unavailable</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* Chain Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Identity Chains</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {Number(identityChainCount?.count ?? 0).toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Content Chains</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {Number(contentChainCount?.count ?? 0).toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Operations</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {Number(operationCount?.count ?? 0).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Peer Nodes — client component for management */}
      <PeerManager />

      {/* Recent Operations */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Operations</h2>
        </div>
        {recentOps.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
            No operations found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">CID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Chain Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Chain ID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {recentOps.map((op) => {
                  const cid = op.cid as string;
                  const chainId = op.chain_id as string;
                  const createdAt = op.created_at as Date;
                  return (
                    <tr key={cid} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <td className="px-4 py-3 font-mono text-xs text-orange-600 dark:text-orange-400">
                        {cid.slice(0, 12)}…
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded">
                          {op.chain_type as string}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {chainId.slice(0, 20)}…
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {createdAt
                          ? formatDistanceToNow(new Date(createdAt), { addSuffix: true })
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
