export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="text-6xl mb-4">☕</div>
      
      <h1 className="text-4xl font-bold mb-4">
        coffee.imajin.ai
      </h1>
      
      <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
        Tips and direct payments. No platform cut.
        <br />
        Directly to your wallet.
      </p>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">How It Works</h2>
        
        <div className="text-left space-y-4 mb-6">
          <div className="flex items-start gap-4">
            <div className="w-8 h-8 bg-orange-100 dark:bg-orange-900 rounded-full flex items-center justify-center text-orange-600 font-bold shrink-0">1</div>
            <div>
              <h3 className="font-semibold">Create your page</h3>
              <p className="text-gray-500 text-sm">Connect your Stripe account or Solana wallet</p>
            </div>
          </div>
          
          <div className="flex items-start gap-4">
            <div className="w-8 h-8 bg-orange-100 dark:bg-orange-900 rounded-full flex items-center justify-center text-orange-600 font-bold shrink-0">2</div>
            <div>
              <h3 className="font-semibold">Share your link</h3>
              <p className="text-gray-500 text-sm">coffee.imajin.ai/yourname</p>
            </div>
          </div>
          
          <div className="flex items-start gap-4">
            <div className="w-8 h-8 bg-orange-100 dark:bg-orange-900 rounded-full flex items-center justify-center text-orange-600 font-bold shrink-0">3</div>
            <div>
              <h3 className="font-semibold">Receive tips directly</h3>
              <p className="text-gray-500 text-sm">Zero platform fees. Just payment processing.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">API Endpoints</h2>
        
        <div className="text-left space-y-3 font-mono text-sm">
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/pages
            <span className="text-gray-500 ml-2">— Create tip page</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/pages/:handle
            <span className="text-gray-500 ml-2">— Get tip page</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/tip
            <span className="text-gray-500 ml-2">— Send a tip</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/tips/:did
            <span className="text-gray-500 ml-2">— Get tips received</span>
          </div>
        </div>
      </div>

      <div className="text-gray-500 text-sm">
        <p>Part of the <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a> sovereign stack</p>
      </div>
    </div>
  );
}
