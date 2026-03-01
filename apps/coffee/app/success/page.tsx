import Link from 'next/link';

interface Props {
  searchParams: { type?: string };
}

export default function SuccessPage({ searchParams }: Props) {
  const isSubscription = searchParams.type === 'subscription';

  return (
    <main className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          <div className="text-6xl mb-4">🧡</div>
          
          <h1 className="text-3xl font-bold mb-4">Thank you!</h1>
          
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            {isSubscription ? (
              <>
                Your monthly support means the world. You're directly funding the 
                development of sovereign infrastructure — no VC strings attached.
                <br /><br />
                <span className="text-sm text-gray-500">
                  You can manage or cancel your subscription anytime from your Stripe receipt.
                </span>
              </>
            ) : (
              <>
                Your support means the world. Every contribution helps keep the lights on 
                while we build the exit from platform dependency.
              </>
            )}
          </p>

          <div className="space-y-3">
            <Link
              href="https://imajin.ai"
              className="block w-full py-3 px-6 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition"
            >
              Learn more about Imajin
            </Link>
            
            <Link
              href="https://discord.gg/6hkQW3uw4m"
              className="block w-full py-3 px-6 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 font-semibold rounded-xl transition"
            >
              Join the Discord
            </Link>

            <Link
              href="https://imajin.ai/articles/the-internet-we-lost"
              className="block w-full py-3 px-6 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white font-medium transition"
            >
              Read: The Internet We Lost →
            </Link>
          </div>
        </div>

        <p className="text-sm text-gray-500 mt-6">
          — Ryan (bobby) 🟠
        </p>
      </div>
    </main>
  );
}
