'use client';

import { useRouter } from 'next/navigation';
import { ImajinFooter } from '@imajin/ui';

export default function Home() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">📊</div>

          <h1 className="text-4xl font-bold mb-4">
            dykil.imajin.ai
          </h1>

          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Sovereign surveys and polls.
            <br />
            Your forms. Your data. No tracking.
          </p>

          {/* CTA Buttons */}
          <div className="flex gap-4 justify-center mb-12">
            <button
              onClick={() => router.push('/create')}
              className="px-8 py-4 bg-orange-500 text-white rounded-lg font-semibold text-lg hover:bg-orange-600 transition shadow-lg"
            >
              Create a Survey
            </button>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-8 py-4 border border-gray-300 dark:border-gray-700 rounded-lg font-semibold text-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              View Dashboard
            </button>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8 text-left">
            <h2 className="text-2xl font-semibold mb-4 text-center">Why Dykil?</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="text-2xl">📝</div>
                <div>
                  <h3 className="font-semibold">Powerful form builder</h3>
                  <p className="text-gray-500 text-sm">Create surveys with text, multiple choice, ratings, and more. Live preview as you build.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🔒</div>
                <div>
                  <h3 className="font-semibold">Privacy-first</h3>
                  <p className="text-gray-500 text-sm">Anonymous responses supported. No tracking scripts, no fingerprinting.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">📈</div>
                <div>
                  <h3 className="font-semibold">Built-in analytics</h3>
                  <p className="text-gray-500 text-sm">View response breakdowns, charts, and export to CSV.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🎯</div>
                <div>
                  <h3 className="font-semibold">Event integration</h3>
                  <p className="text-gray-500 text-sm">Link surveys to Imajin events for pre/post-event feedback.</p>
                </div>
              </div>
            </div>
          </div>

          <ImajinFooter className="mt-8" />
        </div>
      </div>
    </div>
  );
}
