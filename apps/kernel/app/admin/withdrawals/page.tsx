import { getSession } from '@imajin/auth';
import { redirect } from 'next/navigation';
import { getClient } from '@imajin/db';
import WithdrawalsClient from './withdrawals-client';

const sql = getClient();

async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) redirect('/admin');
  const nodeDid = process.env.NODE_DID;
  if (!nodeDid || session.actingAs !== nodeDid) redirect('/admin');
  return session;
}

export default async function AdminWithdrawalsPage() {
  await requireAdmin();

  const rows = await sql`
    SELECT
      id,
      did,
      amount,
      currency,
      emt_email,
      status,
      admin_notes,
      requested_at,
      processed_at
    FROM pay.withdrawal_requests
    ORDER BY requested_at DESC
  `;

  const pending = rows.filter((r) => r.status === 'requested');
  const completed = rows.filter((r) => r.status !== 'requested');

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Withdrawals</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Review and process EMT withdrawal requests
          </p>
        </div>
      </div>

      <WithdrawalsClient
        pendingWithdrawals={pending.map((r) => ({
          id: r.id as string,
          did: r.did as string,
          amount: r.amount as string,
          currency: r.currency as string,
          emtEmail: r.emt_email as string,
          status: r.status as string,
          adminNotes: r.admin_notes as string | null,
          requestedAt: r.requested_at as string | Date,
          processedAt: r.processed_at as string | Date | null,
        }))}
        completedWithdrawals={completed.map((r) => ({
          id: r.id as string,
          did: r.did as string,
          amount: r.amount as string,
          currency: r.currency as string,
          emtEmail: r.emt_email as string,
          status: r.status as string,
          adminNotes: r.admin_notes as string | null,
          requestedAt: r.requested_at as string | Date,
          processedAt: r.processed_at as string | Date | null,
        }))}
      />
    </div>
  );
}
