import { redirect } from 'next/navigation';
import { getSession } from '@imajin/auth';
import { db, transactions } from '@/src/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';

interface SuccessPageProps {
  searchParams: { session_id?: string };
}

export default async function TopupSuccessPage({ searchParams }: SuccessPageProps) {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
    const payUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
    redirect(`${authUrl}/login?next=${encodeURIComponent(`${payUrl}/topup/success`)}`);
  }

  const { session_id: stripeSessionId } = searchParams;
  let amount: number | null = null;

  if (stripeSessionId) {
    const [tx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.stripeId, stripeSessionId))
      .limit(1);

    if (tx) {
      amount = parseFloat(tx.amount);
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-8 pt-8">
      <div className="text-center space-y-4">
        <div className="text-6xl mb-4">✅</div>
        <h1 className="text-3xl font-bold text-white">Funds Added!</h1>
        <p className="text-zinc-400">
          {amount !== null
            ? `$${amount.toFixed(2)} CAD has been credited to your MJNx balance.`
            : 'Your top-up has been processed successfully.'}
        </p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-500">Status</span>
          <span className="text-green-400 font-medium">Completed</span>
        </div>
        {amount !== null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Amount</span>
            <span className="text-white font-medium">
              {new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: 'CAD',
              }).format(amount)}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Link
          href="/pay"
          className="block w-full text-center px-4 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-xl transition-colors"
        >
          Back to Dashboard
        </Link>
        <Link
          href="/pay/history"
          className="block w-full text-center px-4 py-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 font-medium rounded-xl transition-colors"
        >
          View Transaction History
        </Link>
      </div>
    </div>
  );
}
