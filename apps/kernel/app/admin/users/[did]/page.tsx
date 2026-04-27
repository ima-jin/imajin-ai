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
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h1 className="text-xl font-bold text-gray-900 dark:text-primary font-mono">
                {identity.handle ? `@${identity.handle as string}` : (identity.name as string | null) ?? 'Unknown'}
              </h1>
              {isSuspended && (
                <span className="text-xs bg-error/10 dark:bg-error/40 text-error dark:text-error px-2 py-0.5 font-medium">
                  Suspended
                </span>
              )}
              <TierBadge tier={identity.tier as string} />
              <span className="text-xs bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary px-2 py-0.5 ">
                {identity.scope as string}{identity.subtype ? `/${identity.subtype as string}` : ''}
              </span>
            </div>
            <p className="font-mono text-xs text-secondary dark:text-secondary break-all mb-1">
              {identity.id as string}
            </p>
            {identity.name && (
              <p className="text-sm text-muted dark:text-primary">{identity.name as string}</p>
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
            <p className="text-xs text-secondary dark:text-secondary mb-0.5">Public Key</p>
            <p className="font-mono text-xs text-gray-700 dark:text-primary">{shortKey}</p>
          </div>
          <div>
            <p className="text-xs text-secondary dark:text-secondary mb-0.5">Created</p>
            <p className="text-xs text-gray-700 dark:text-primary">{createdTimestamp}</p>
          </div>
          <div>
            <p className="text-xs text-secondary dark:text-secondary mb-0.5">Invited By</p>
            {inviterDid ? (
              <a href={`/admin/users/${encodeURIComponent(inviterDid)}`} className="text-xs text-imajin-orange dark:text-imajin-orange hover:underline">
                {inviterHandle ? `@${inviterHandle}` : inviterName ?? inviterDid.slice(0, 20) + '…'}
              </a>
            ) : (
              <p className="text-xs text-secondary dark:text-secondary">Founding member</p>
            )}
          </div>
          {isSuspended && (
            <div>
              <p className="text-xs text-secondary dark:text-secondary mb-0.5">Suspended</p>
              <p className="text-xs text-error dark:text-error">
                {formatDistanceToNow(new Date(identity.suspended_at as Date), { addSuffix: true })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Auth Methods + Metadata */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary mb-3 font-mono">Email &amp; Auth Methods</h2>
          <div className="space-y-2 text-sm">
            {contactEmail && (
              <Row label="Contact Email" value={contactEmail} />
            )}
            {authMethods.length > 0 ? (
              authMethods.map((am, i) => (
                <Row key={i} label={`${am.type as string}`} value={am.value as string} mono />
              ))
            ) : (
              <p className="text-xs text-secondary dark:text-secondary">No auth methods</p>
            )}
          </div>
        </div>
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary mb-3 font-mono">Metadata</h2>
          {metadata && Object.keys(metadata).length > 0 ? (
            <pre className="text-xs text-muted dark:text-primary bg-gray-50 dark:bg-surface-surface/50 p-3 overflow-x-auto max-h-48">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-secondary dark:text-secondary">Empty</p>
          )}
        </div>
      </div>

      {/* 2-col grid: Profile + Balance + Connections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Profile */}
        <div className="lg:col-span-2 bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary mb-3 font-mono">Profile</h2>
          {profile ? (
            <div className="space-y-2 text-sm">
              <Row label="Display Name" value={profile.display_name as string | null} />
              <Row label="Bio" value={profile.bio as string | null} />
              <Row label="Avatar" value={profile.avatar as string | null} mono />
            </div>
          ) : (
            <p className="text-sm text-secondary dark:text-secondary">No profile</p>
          )}
        </div>

        {/* Balance + Connections */}
        <div className="space-y-4">
          <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-primary mb-3 font-mono">Balance</h2>
            {balance ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-secondary dark:text-secondary">Cash</span>
                  <span className="font-medium text-gray-900 dark:text-primary font-mono">
                    {balance.cash_amount as string} {balance.currency as string}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-secondary dark:text-secondary">Credit</span>
                  <span className="font-medium text-gray-900 dark:text-primary font-mono">
                    {balance.credit_amount as string} {balance.currency as string}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-secondary dark:text-secondary">No balance</p>
            )}
          </div>

          <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-primary mb-3 font-mono">Connections</h2>
            <p className="text-3xl font-bold text-gray-900 dark:text-primary">
              {Number(connCount?.total ?? 0).toLocaleString()}
            </p>
            <p className="text-xs text-secondary dark:text-secondary mt-1">active connections</p>
          </div>
        </div>
      </div>

      {/* Attestations */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary font-mono">Recent Attestations</h2>
        </div>
        {attestations.length === 0 ? (
          <p className="px-5 py-6 text-sm text-secondary dark:text-secondary text-center">None</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50">
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Type</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Role</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Counterpart</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Status</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Issued</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {attestations.map((att) => {
                  const isSubject = att.subject_did === decodedDid;
                  const counterpart = isSubject
                    ? (att.issuer_did as string)
                    : (att.subject_did as string);
                  const shortCounterpart = `${counterpart.slice(0, 16)}…${counterpart.slice(-6)}`;
                  const issuedAt = att.issued_at as Date;
                  return (
                    <tr key={att.id as string} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40">
                      <td className="px-4 py-2.5">
                        <span className="font-mono bg-gray-100 dark:bg-surface-elevated text-gray-700 dark:text-primary px-1.5 py-0.5 ">
                          {att.type as string}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted dark:text-secondary">
                        {isSubject ? 'subject' : 'issuer'}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-secondary dark:text-secondary">
                        {shortCounterpart}
                      </td>
                      <td className="px-4 py-2.5 text-muted dark:text-secondary">
                        {att.attestation_status as string}
                      </td>
                      <td className="px-4 py-2.5 text-secondary dark:text-secondary whitespace-nowrap">
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
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary font-mono">Recent Transactions</h2>
        </div>
        {transactions.length === 0 ? (
          <p className="px-5 py-6 text-sm text-secondary dark:text-secondary text-center">None</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50">
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Type</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Amount</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">From</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">To</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Status</th>
                  <th className="text-left px-4 py-2 text-secondary dark:text-secondary font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {transactions.map((tx) => {
                  const fromDid = tx.from_did as string | null;
                  const toDid = tx.to_did as string;
                  const shortFrom = fromDid ? `${fromDid.slice(0, 12)}…` : 'external';
                  const shortTo = `${toDid.slice(0, 12)}…`;
                  const createdAt = tx.created_at as Date;
                  return (
                    <tr key={tx.id as string} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40">
                      <td className="px-4 py-2.5">
                        <span className="bg-gray-100 dark:bg-surface-elevated text-gray-700 dark:text-primary px-1.5 py-0.5 ">
                          {tx.type as string}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono font-medium text-gray-900 dark:text-primary">
                        {tx.amount as string} {tx.currency as string}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-secondary dark:text-secondary">{shortFrom}</td>
                      <td className="px-4 py-2.5 font-mono text-secondary dark:text-secondary">{shortTo}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={tx.status as string} />
                      </td>
                      <td className="px-4 py-2.5 text-secondary dark:text-secondary whitespace-nowrap">
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
      <span className="text-secondary dark:text-secondary w-28 shrink-0">{label}</span>
      <span className={`text-gray-700 dark:text-primary break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {value ?? <span className="text-secondary dark:text-muted">—</span>}
      </span>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    soft: 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary',
    preliminary: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    established: 'bg-success/10 dark:bg-success/40 text-success dark:text-success',
    steward: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
    operator: 'bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange',
  };
  return (
    <span className={`text-xs px-2 py-0.5 font-medium ${styles[tier] ?? styles.soft}`}>
      {tier}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-success/10 dark:bg-success/40 text-success dark:text-success',
    pending: 'bg-yellow-100 dark:bg-warning/20/40 text-warning dark:text-warning',
    failed: 'bg-error/10 dark:bg-error/40 text-error dark:text-error',
    refunded: 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary',
  };
  return (
    <span className={`px-1.5 py-0.5  text-xs ${styles[status] ?? 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary'}`}>
      {status}
    </span>
  );
}
