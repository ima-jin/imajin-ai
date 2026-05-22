import { db, withdrawalRequests } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import MarkSentButton from './mark-sent-button';

export const dynamic = 'force-dynamic';

export default async function WithdrawalsPage() {
  const pending = await db
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.status, 'requested'))
    .orderBy(desc(withdrawalRequests.requestedAt));

  const completed = await db
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.status, 'sent'))
    .orderBy(desc(withdrawalRequests.processedAt));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
        💸 Withdrawal Requests
      </h1>

      {/* Pending */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-3 text-gray-800 dark:text-gray-200">
          Pending ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm">No pending requests.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-600 dark:text-gray-400">
                  <th className="py-2 pr-4">ID</th>
                  <th className="py-2 pr-4">DID</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">EMT Email</th>
                  <th className="py-2 pr-4">Requested</th>
                  <th className="py-2 pr-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((wr) => (
                  <tr
                    key={wr.id}
                    className="border-b border-gray-100 dark:border-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">{wr.id}</td>
                    <td className="py-2 pr-4 font-mono text-xs truncate max-w-[200px]">
                      {wr.did}
                    </td>
                    <td className="py-2 pr-4 font-medium">
                      ${Number.parseFloat(wr.amount).toFixed(2)} {wr.currency}
                    </td>
                    <td className="py-2 pr-4">{wr.emtEmail}</td>
                    <td className="py-2 pr-4 text-xs text-gray-500">
                      {wr.requestedAt?.toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4">
                      <MarkSentButton id={wr.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Completed */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-gray-800 dark:text-gray-200">
          Completed ({completed.length})
        </h2>
        {completed.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm">No completed withdrawals.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-600 dark:text-gray-400">
                  <th className="py-2 pr-4">ID</th>
                  <th className="py-2 pr-4">DID</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">EMT Email</th>
                  <th className="py-2 pr-4">Processed</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((wr) => (
                  <tr
                    key={wr.id}
                    className="border-b border-gray-100 dark:border-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">{wr.id}</td>
                    <td className="py-2 pr-4 font-mono text-xs truncate max-w-[200px]">
                      {wr.did}
                    </td>
                    <td className="py-2 pr-4 font-medium">
                      ${Number.parseFloat(wr.amount).toFixed(2)} {wr.currency}
                    </td>
                    <td className="py-2 pr-4">{wr.emtEmail}</td>
                    <td className="py-2 pr-4 text-xs text-gray-500">
                      {wr.processedAt?.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
