import { ImajinFooter } from '@imajin/ui';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">🔗</div>

          <h1 className="text-4xl font-bold mb-4">
            links.imajin.ai
          </h1>

          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Sovereign link-in-bio pages.
            <br />
            Your links. Your data. No tracking.
          </p>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8 text-left">
            <h2 className="text-2xl font-semibold mb-4 text-center">Why Links?</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="text-2xl">🚫</div>
                <div>
                  <h3 className="font-semibold">No invasive tracking</h3>
                  <p className="text-gray-500 text-sm">We count clicks, not people. No fingerprinting, no cookies, no profiles.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🎨</div>
                <div>
                  <h3 className="font-semibold">Custom themes</h3>
                  <p className="text-gray-500 text-sm">Built-in presets or customize your own colors and style.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">⚡</div>
                <div>
                  <h3 className="font-semibold">Fast & simple</h3>
                  <p className="text-gray-500 text-sm">No bloat. Just your links, loading instantly.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🔗</div>
                <div>
                  <h3 className="font-semibold">Integrates with Imajin</h3>
                  <p className="text-gray-500 text-sm">Connect your profile, coffee page, and more.</p>
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
