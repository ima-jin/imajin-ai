export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <h1 className="text-4xl font-bold mb-4">
        registry.imajin.ai
      </h1>
      
      <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
        The phone book for the sovereign network.
        <br />
        Register your node, get a subdomain.
      </p>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">API Endpoints</h2>
        
        <div className="text-left space-y-3 font-mono text-sm">
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/node/register
            <span className="text-gray-500 ml-2">— Register a new node</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/node/heartbeat
            <span className="text-gray-500 ml-2">— Send liveness ping</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/node/list
            <span className="text-gray-500 ml-2">— List all nodes</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/node/lookup/:id
            <span className="text-gray-500 ml-2">— Find node by DID or hostname</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/builds/verify
            <span className="text-gray-500 ml-2">— Verify build hash</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">How It Works</h2>
        
        <ol className="text-left space-y-2 text-gray-600 dark:text-gray-400">
          <li><span className="text-orange-500 font-bold">1.</span> Run a signed Imajin build</li>
          <li><span className="text-orange-500 font-bold">2.</span> Node generates keypair and DID</li>
          <li><span className="text-orange-500 font-bold">3.</span> Send attestation to /api/node/register</li>
          <li><span className="text-orange-500 font-bold">4.</span> Registry verifies build hash</li>
          <li><span className="text-orange-500 font-bold">5.</span> Get your-hostname.imajin.ai</li>
          <li><span className="text-orange-500 font-bold">6.</span> Send daily heartbeats</li>
        </ol>
      </div>

      <div className="text-gray-500 text-sm">
        <p>Part of the <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a> sovereign stack</p>
        <p className="mt-2">
          <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline">GitHub</a>
          {' · '}
          <a href="https://docs.imajin.ai" className="hover:underline">Docs</a>
        </p>
      </div>
    </div>
  );
}
