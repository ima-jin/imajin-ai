import { redirect } from 'next/navigation';
import { getSession } from '@imajin/auth';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PayoutActions } from './PayoutActions';

interface ConnectStatus {
  did: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  onboardingComplete: boolean;
  defaultCurrency: string;
}

async function getConnectStatus(did: string, cookieHeader: string): Promise<ConnectStatus | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
    const response = await fetch(`${baseUrl}/api/connect/status?did=${did}`, {
      headers: {
        'Cookie': cookieHeader,
        'Cache-Control': 'no-cache',
      },
    });

    if (response.status === 404 || response.status === 403) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch connect status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching connect status:', error);
    return null;
  }
}

export default async function PayoutsPage() {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
    const payUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
    redirect(`${authUrl}/login?next=${encodeURIComponent(`${payUrl}/payouts`)}`);
  }

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map(c => `${c.name}=${c.value}`).join('; ');
  const status = await getConnectStatus(session.id, cookieHeader);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          ← Dashboard
        </Link>
        <h1 className="text-3xl font-bold text-white">Payouts</h1>
      </div>

      {/* Payout Status Card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        {!status ? (
          // State A - Not connected
          <div className="text-center space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-white mb-2">Set up payouts</h2>
              <p className="text-zinc-400 max-w-2xl mx-auto">
                Connect your bank account to receive payouts from events, tips, and sales.
              </p>
            </div>
            <PayoutActions
              status="not_connected"
              did={session.id}
            />
          </div>
        ) : !status.onboardingComplete ? (
          // State B - Onboarding incomplete
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white mb-2">Complete your setup</h2>
              <p className="text-zinc-400">
                Your payout account needs more information to start receiving funds.
              </p>
            </div>

            {/* Capabilities Status */}
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <span className={`text-lg ${status.chargesEnabled ? 'text-green-400' : 'text-red-400'}`}>
                  {status.chargesEnabled ? '✅' : '❌'}
                </span>
                <span className="text-sm text-zinc-300">
                  Charges enabled
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-lg ${status.payoutsEnabled ? 'text-green-400' : 'text-red-400'}`}>
                  {status.payoutsEnabled ? '✅' : '❌'}
                </span>
                <span className="text-sm text-zinc-300">
                  Payouts enabled
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-lg ${status.detailsSubmitted ? 'text-green-400' : 'text-red-400'}`}>
                  {status.detailsSubmitted ? '✅' : '❌'}
                </span>
                <span className="text-sm text-zinc-300">
                  Details submitted
                </span>
              </div>
            </div>

            <PayoutActions
              status="incomplete_onboarding"
              did={session.id}
            />
          </div>
        ) : (
          // State C - Connected
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-green-400 text-4xl mb-3">✅</div>
              <h2 className="text-xl font-semibold text-white mb-2">Payouts enabled</h2>
              <p className="text-zinc-400">
                Default currency: {status.defaultCurrency}
              </p>
            </div>

            <div className="text-center">
              <PayoutActions
                status="connected"
                did={session.id}
              />
              <p className="text-xs text-zinc-500 mt-3">
                View payout schedule, bank details, and transaction history in the Stripe Dashboard
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}