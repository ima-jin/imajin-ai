export default function Home() {
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

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8 text-left">
            <h2 className="text-2xl font-semibold mb-4 text-center">Why Dykil?</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="text-2xl">📝</div>
                <div>
                  <h3 className="font-semibold">Generic form engine</h3>
                  <p className="text-gray-500 text-sm">Build any kind of survey with multiple field types: text, select, rating, and more.</p>
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
                  <p className="text-gray-500 text-sm">View response aggregation and insights for your surveys.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🎯</div>
                <div>
                  <h3 className="font-semibold">Event integration</h3>
                  <p className="text-gray-500 text-sm">Link surveys to Imajin events for RSVPs, feedback, and more.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="text-gray-500 text-sm">
            <p>Part of the <a href="https://imajin.ai" className="text-blue-500 hover:underline">Imajin</a> sovereign stack</p>
          </div>
        </div>
      </div>
    </div>
  );
}
