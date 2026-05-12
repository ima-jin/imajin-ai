import { getClient } from '@imajin/db';
import { getSession } from '@imajin/auth';
import { redirect } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import DepositMatchForm from './deposit-form';

const sql = getClient();

async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) redirect('/admin');
  const nodeDid = process.env.NODE_DID;
  if (!nodeDid || session.actingAs !== nodeDid) redirect('/admin');
  return session;
}

export default async function AdminDepositsPage() {
  await requireAdmin();

  const recentDeposits = await sql`
    SELECT
      t.id,
      t.to_did,
      t.amount,
      t.currency,
      t.status,
      t.metadata,
      t.created_at,
      p.display_name
    FROM pay.transactions t
    LEFT JOIN profile.profiles p ON p.did = t.to_did
    WHERE t.type = 'topup' AND t.source = 'fiat'
    ORDER BY t.created_at DESC
    LIMIT 20
  `;

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Deposits</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Match EMT transfers to MJNx credits
        </p>
      </div>

      <DepositMatchForm />

      {/* Recent deposits table */}
      <div className="mt-8 rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Deposits</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Last 20 top-ups for reference / duplicate detection
          </p>
        </div>
        {recentDeposits.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
            No deposits yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">ID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Recipient</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Memo</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {recentDeposits.map((row) => {
                  const createdAt = row.created_at ? new Date(row.created_at as string) : null;
                  const relTime = createdAt
                    ? formatDistanceToNow(createdAt, { addSuffix: true })
                    : '—';
                  const metadata = (row.metadata as Record<string, unknown>) || {};
                  const memo = typeof metadata.memo === 'string' ? metadata.memo : '';
                  const displayName = row.display_name as string | null;
                  const did = row.to_did as string;
                  const didShort = `${did.slice(0, 16)}…${did.slice(-6)}`;

                  return (
                    <tr key={row.id as string} className="hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {(row.id as string).slice(0, 16)}…
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-gray-700 dark:text-gray-300 text-xs">
                          {displayName ?? <span className="text-gray-400 dark:text-gray-600">—</span>}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-0.5">
                          {didShort}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300 font-medium">
                        ${Number(row.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {row.currency as string}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 max-w-[200px] truncate" title={memo}>
                        {memo || <span className="text-gray-400 dark:text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          row.status === 'completed'
                            ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }`}>
                          {row.status as string}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {relTime}
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
