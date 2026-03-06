import Link from 'next/link';
import { MarkdownContent } from '@imajin/ui';

interface Props {
  searchParams: { type?: string; handle?: string };
}

async function getCreatorPage(handle: string) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3009';
  try {
    const res = await fetch(`${baseUrl}/api/pages/${handle}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function SuccessPage({ searchParams }: Props) {
  const isSubscription = searchParams.type === 'subscription';
  const handle = searchParams.handle;

  const creatorPage = handle ? await getCreatorPage(handle) : null;
  const hasCustomContent = creatorPage?.thankYouContent?.trim();

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center">
        <div className="bg-gray-800 rounded-2xl shadow-xl p-8 border border-gray-700">
          <div className="text-6xl mb-4">🧡</div>

          <h1 className="text-3xl font-bold text-white mb-4">Thank you!</h1>

          {hasCustomContent ? (
            <div className="text-left mb-6">
              <MarkdownContent content={creatorPage.thankYouContent} />
            </div>
          ) : (
            <p className="text-gray-400 mb-6">
              {isSubscription ? (
                <>
                  Your monthly support means the world. You&apos;re directly funding the
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
          )}

          <div className="space-y-3">
            <Link
              href="https://imajin.ai"
              className="block w-full py-3 px-6 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition"
            >
              Learn more about Imajin
            </Link>

            <Link
              href="https://discord.gg/kWGHUY8wbe"
              className="block w-full py-3 px-6 bg-gray-700 hover:bg-gray-600 text-gray-200 font-semibold rounded-xl transition"
            >
              Join the Discord
            </Link>

            <Link
              href="https://imajin.ai/articles/the-internet-we-lost"
              className="block w-full py-3 px-6 text-gray-400 hover:text-white font-medium transition"
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
