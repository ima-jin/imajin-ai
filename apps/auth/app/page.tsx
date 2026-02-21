export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <h1 className="text-4xl font-bold mb-4">
        auth.imajin.ai
      </h1>
      
      <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
        Sovereign identity for humans and agents.
        <br />
        No passwords. No OAuth. Just cryptography.
      </p>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">API Endpoints</h2>
        
        <div className="text-left space-y-3 font-mono text-sm">
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/register
            <span className="text-gray-500 ml-2">— Register with public key</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/challenge
            <span className="text-gray-500 ml-2">— Get challenge to sign</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/authenticate
            <span className="text-gray-500 ml-2">— Submit signature, get token</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/validate
            <span className="text-gray-500 ml-2">— Validate a token</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/verify
            <span className="text-gray-500 ml-2">— Verify signed message</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/lookup/:id
            <span className="text-gray-500 ml-2">— Look up identity by DID</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">Identity Types</h2>
        
        <div className="grid grid-cols-2 gap-4 text-left">
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded">
            <div className="text-lg font-semibold mb-2">👤 Human</div>
            <p className="text-gray-500 text-sm">A person with a keypair.</p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded">
            <div className="text-lg font-semibold mb-2">🤖 Agent</div>
            <p className="text-gray-500 text-sm">AI or bot. Always labeled.</p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded">
            <div className="text-lg font-semibold mb-2">📡 Device</div>
            <p className="text-gray-500 text-sm">Units, nodes, IoT hardware.</p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded">
            <div className="text-lg font-semibold mb-2">🏢 Org</div>
            <p className="text-gray-500 text-sm">Organization or group.</p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded">
            <div className="text-lg font-semibold mb-2">🎫 Event</div>
            <p className="text-gray-500 text-sm">Time-bound gathering.</p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded">
            <div className="text-lg font-semibold mb-2">⚙️ Service</div>
            <p className="text-gray-500 text-sm">Backend service or API.</p>
          </div>
        </div>
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
