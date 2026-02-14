import Link from 'next/link';

export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <h1 className="text-4xl font-bold mb-4">
        profile.imajin.ai
      </h1>
      
      <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
        Sovereign identity profiles on the Imajin network.
        <br />
        Your identity, your data.
      </p>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4">API Endpoints</h2>
        
        <div className="text-left space-y-3 font-mono text-sm">
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/profile
            <span className="text-gray-500 ml-2">— Create profile</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/profile/:id
            <span className="text-gray-500 ml-2">— Get by DID or handle</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-yellow-600 font-bold">PUT</span> /api/profile/:id
            <span className="text-gray-500 ml-2">— Update profile</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-red-600 font-bold">DELETE</span> /api/profile/:id
            <span className="text-gray-500 ml-2">— Delete profile</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-blue-600 font-bold">GET</span> /api/profile/search
            <span className="text-gray-500 ml-2">— Search profiles</span>
          </div>
          
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded">
            <span className="text-green-600 font-bold">POST</span> /api/profile/claim-handle
            <span className="text-gray-500 ml-2">— Claim a handle</span>
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
