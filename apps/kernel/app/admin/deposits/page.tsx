import { requireAdmin } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { redirect } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import DepositForm from './deposit-form';

const sql = getClient();

export default async function AdminDepositsPage() {
  const session = await requireAdmin();
  if (!session) redirect('/admin');

  const deposits = await sql`
    SELECT id, to_did, amount, currency, metadata, created_at
    FROM pay.transactions
    WHERE type = 'topup' AND source = 'fiat'
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
        💰 Deposit Match
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
        Record EMT deposits and credit MJNx balances
      </p>

      <DepositForm />

      <div className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Recent Deposits
        </h2>

        {deposits.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No deposits yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Amount
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Currency
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Target DID
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Memo
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {deposits.map((d: any) => {
                  const meta =
                    typeof d.metadata === 'string'
                      ? JSON.parse(d.metadata)
                      : d.metadata ?? {};
                  const did = d.to_did as string;
                  const didShort = `${did.slice(0, 16)}…${did.slice(-6)}`;
                  const createdAt = d.created_at
                    ? formatDistanceToNow(new Date(d.created_at as string), {
                        addSuffix: true,
                      })
                    : '—';

                  return (
                    <tr
                      key={d.id as string}
                      className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {createdAt}
                      </td>
                      <td className="px-4 py-3 text-gray-900 dark:text-white font-mono">
                        ${Number(d.amount).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {d.currency}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400 font-mono text-xs">
                        {didShort}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
                        {meta.memo || '—'}
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
