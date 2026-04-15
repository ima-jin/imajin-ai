import { getClient } from '@imajin/db';
import { formatDistanceToNow } from 'date-fns';
import { notFound } from 'next/navigation';
import UserActions from './actions';

const sql = getClient();

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ did: string }>;
}) {
  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  // Identity — only select columns guaranteed to exist, fetch extras safely
  const [identity] = await sql`
    SELECT id, handle, name, scope, subtype, tier, public_key, suspended_at, created_at
    FROM auth.identities
    WHERE id = ${decodedDid}
    LIMIT 1
  `;
  if (!identity) notFound();

  // Extra identity columns (may not exist on all envs)
  let contactEmail: string | null = null;
  let metadata: Record<string, unknown> | null = null;
  try {
    const [extra] = await sql`SELECT contact_email, metadata FROM auth.identities WHERE id = ${decodedDid} LIMIT 1`;
    if (extra) {
      contactEmail = extra.contact_email as string | null;
      metadata = extra.metadata as Record<string, unknown> | null;
    }
  } catch {}

  // Auth methods (login email, etc.)
  let authMethods: Record<string, unknown>[] = [];
  try {
    authMethods = await sql`
      SELECT type, value, created_at FROM auth.auth_methods
      WHERE did = ${decodedDid}
      ORDER BY created_at ASC
    `;
  } catch {}

  // Invited by (who invited this user)
  let invitedByRow: Record<string, unknown> | undefined;
  try {
    const invitedByRows = await sql`
      SELECT i.from_did, id2.handle AS inviter_handle, id2.name AS inviter_name
      FROM connections.invites i
      LEFT JOIN auth.identities id2 ON id2.id = i.from_did
      WHERE (i.consumed_by = ${decodedDid} OR (i.to_did = ${decodedDid} AND i.status = 'accepted'))
      LIMIT 1
    `;
    invitedByRow = invitedByRows[0];
  } catch {
    // connections.invites may not exist or schema mismatch — graceful fallback
  }

  // Profile
  const [profile] = await sql`
    SELECT display_name, bio, avatar, avatar_asset_id
    FROM profile.profiles
    WHERE did = ${decodedDid}
    LIMIT 1
  `;

  // Balance
  const [balance] = await sql`
    SELECT cash_amount, credit_amount, currency
    FROM pay.balances
    WHERE did = ${decodedDid}
    LIMIT 1
  `;

  // Connections count
  const [connCount] = await sql`
    SELECT COUNT(*) AS total
    FROM connections.connections
    WHERE (did_a = ${decodedDid} OR did_b = ${decodedDid})
    AND disconnected_at IS NULL
  `;

  // Recent attestations
  const attestations = await sql`
    SELECT id, type, issuer_did, subject_did, attestation_status, issued_at
    FROM auth.attestations
    WHERE subject_did = ${decodedDid} OR issuer_did = ${decodedDid}
    ORDER BY issued_at DESC
    LIMIT 15
  `;

  // Recent transactions
  const transactions = await sql`
    SELECT id, type, service, amount, currency, from_did, to_did, status, created_at
    FROM pay.transactions
    WHERE to_did = ${decodedDid} OR from_did = ${decodedDid}
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const isSuspended = !!identity.suspended_at;
  const publicKey = identity.public_key as string;
  const shortKey = publicKey ? `${publicKey.slice(0, 20)}…${publicKey.slice(-8)}` : '—';
  const createdAt = identity.created_at as Date;
  const createdTimestamp = createdAt
    ? new Date(createdAt).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : '—';
  const inviterHandle = invitedByRow?.inviter_handle as string | null;
  const inviterName = invitedByRow?.inviter_name as string | null;
  const inviterDid = invitedByRow?.from_did as string | null;

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      {/* Header card */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                {identity.handle ? `@${identity.handle as string}` : (identity.name as string | null) ?? 'Unknown'}
              </h1>
              {isSuspended && (
                <span className="text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 px-2 py-0.5 rounded-full font-medium">
                  Suspended
                </span>
              )}
              <TierBadge tier={identity.tier as string} />
              <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded">
                {identity.scope as string}{identity.subtype ? `/${identity.subtype as string}` : ''}
              </span>
            </div>
            <p className="font-mono text-xs text-gray-500 dark:text-gray-400 break-all mb-1">
              {identity.id as string}
            </p>
            {identity.name && (
              <p className="text-sm text-gray-600 dark:text-gray-300">{identity.name as string}</p>
            )}
          </div>
          <UserActions
            did={decodedDid}
            currentTier={identity.tier as string}
            isSuspended={isSuspended}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Public Key</p>
            <p className="font-mono text-xs text-gray-700 dark:text-gray-300">{shortKey}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Created</p>
            <p className="text-xs text-gray-700 dark:text-gray-300">{createdTimestamp}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Invited By</p>
            {inviterDid ? (
              <a href={`/admin/users/${encodeURIComponent(inviterDid)}`} className="text-xs text-orange-600 dark:text-orange-400 hover:underline">
                {inviterHandle ? `@${inviterHandle}` : inviterName ?? inviterDid.slice(0, 20) + '…'}
              </a>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">Founding member</p>
            )}
          </div>
          {isSuspended && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Suspended</p>
              <p className="text-xs text-red-600 dark:text-red-400">
                {formatDistanceToNow(new Date(identity.suspended_at as Date), { addSuffix: true })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Auth Methods + Metadata */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Email &amp; Auth Methods</h2>
          <div className="space-y-2 text-sm">
            {contactEmail && (
              <Row label="Contact Email" value={contactEmail} />
            )}
            {authMethods.length > 0 ? (
              authMethods.map((am, i) => (
                <Row key={i} label={`${am.type as string}`} value={am.value as string} mono />
              ))
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">No auth methods</p>
            )}
          </div>
        </div>
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Metadata</h2>
          {metadata && Object.keys(metadata).length > 0 ? (
            <pre className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 overflow-x-auto max-h-48">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500">Empty</p>
          )}
        </div>
      </div>

      {/* 2-col grid: Profile + Balance + Connections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Profile */}
        <div className="lg:col-span-2 rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Profile</h2>
          {profile ? (
            <div className="space-y-2 text-sm">
              <Row label="Display Name" value={profile.display_name as string | null} />
              <Row label="Bio" value={profile.bio as string | null} />
              <Row label="Avatar" value={profile.avatar as string | null} mono />
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500">No profile</p>
          )}
        </div>

        {/* Balance + Connections */}
        <div className="space-y-4">
          <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Balance</h2>
            {balance ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Cash</span>
                  <span className="font-medium text-gray-900 dark:text-white font-mono">
                    {balance.cash_amount as string} {balance.currency as string}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Credit</span>
                  <span className="font-medium text-gray-900 dark:text-white font-mono">
                    {balance.credit_amount as string} {balance.currency as string}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-500">No balance</p>
            )}
          </div>

          <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Connections</h2>
            <p className="text-3xl font-bold text-gray-900 dark:text-white">
              {Number(connCount?.total ?? 0).toLocaleString()}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">active connections</p>
          </div>
        </div>
      </div>

      {/* Attestations */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Attestations</h2>
        </div>
        {attestations.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-400 dark:text-gray-500 text-center">None</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50">
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Type</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Role</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Counterpart</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Status</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Issued</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {attestations.map((att) => {
                  const isSubject = att.subject_did === decodedDid;
                  const counterpart = isSubject
                    ? (att.issuer_did as string)
                    : (att.subject_did as string);
                  const shortCounterpart = `${counterpart.slice(0, 16)}…${counterpart.slice(-6)}`;
                  const issuedAt = att.issued_at as Date;
                  return (
                    <tr key={att.id as string} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <td className="px-4 py-2.5">
                        <span className="font-mono bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded">
                          {att.type as string}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">
                        {isSubject ? 'subject' : 'issuer'}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-gray-400">
                        {shortCounterpart}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">
                        {att.attestation_status as string}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {issuedAt
                          ? formatDistanceToNow(new Date(issuedAt), { addSuffix: true })
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

      {/* Transactions */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Transactions</h2>
        </div>
        {transactions.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-400 dark:text-gray-500 text-center">None</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50">
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Type</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Amount</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">From</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">To</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Status</th>
                  <th className="text-left px-4 py-2 text-gray-500 dark:text-gray-400 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {transactions.map((tx) => {
                  const fromDid = tx.from_did as string | null;
                  const toDid = tx.to_did as string;
                  const shortFrom = fromDid ? `${fromDid.slice(0, 12)}…` : 'external';
                  const shortTo = `${toDid.slice(0, 12)}…`;
                  const createdAt = tx.created_at as Date;
                  return (
                    <tr key={tx.id as string} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <td className="px-4 py-2.5">
                        <span className="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded">
                          {tx.type as string}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono font-medium text-gray-900 dark:text-white">
                        {tx.amount as string} {tx.currency as string}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-gray-400">{shortFrom}</td>
                      <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-gray-400">{shortTo}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={tx.status as string} />
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
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

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 dark:text-gray-400 w-28 shrink-0">{label}</span>
      <span className={`text-gray-700 dark:text-gray-300 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {value ?? <span className="text-gray-400 dark:text-gray-600">—</span>}
      </span>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    soft: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
    preliminary: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    established: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
    steward: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
    operator: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[tier] ?? styles.soft}`}>
      {tier}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
    pending: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400',
    failed: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400',
    refunded: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${styles[status] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
      {status}
    </span>
  );
}
