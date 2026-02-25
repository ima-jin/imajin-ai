import Link from 'next/link';

export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="mb-8">
        <div className="text-6xl mb-4">🟠</div>
        <h1 className="text-4xl font-bold mb-4 text-white">
          profile.imajin.ai
        </h1>

        <p className="text-xl text-gray-400 mb-8">
          Sovereign identity profiles on the Imajin network.
          <br />
          Your identity, your data.
        </p>

        <Link
          href="/register"
          className="inline-block px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold"
        >
          Create Your Identity →
        </Link>
      </div>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4 text-white">API Endpoints</h2>

        <div className="text-left space-y-3 font-mono text-sm">
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/register
            <span className="text-gray-500 ml-2">— Register new identity</span>
          </div>

          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/profile
            <span className="text-gray-500 ml-2">— Create profile (auth)</span>
          </div>

          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-blue-500 font-bold">GET</span> /api/profile/:id
            <span className="text-gray-500 ml-2">— Get by DID or handle</span>
          </div>

          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-yellow-500 font-bold">PUT</span> /api/profile/:id
            <span className="text-gray-500 ml-2">— Update profile (auth)</span>
          </div>

          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-red-500 font-bold">DELETE</span> /api/profile/:id
            <span className="text-gray-500 ml-2">— Delete profile (auth)</span>
          </div>

          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-blue-500 font-bold">GET</span> /api/profile/search
            <span className="text-gray-500 ml-2">— Search profiles</span>
          </div>

          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/profile/claim-handle
            <span className="text-gray-500 ml-2">— Claim a handle (auth)</span>
          </div>
        </div>
      </div>

      <div className="text-gray-500 text-sm">
        <p>Part of the <a href="https://imajin.ai" className="text-[#F59E0B] hover:underline">Imajin</a> sovereign stack</p>
        <p className="mt-2">
          <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline text-gray-400">GitHub</a>
          {' · '}
          <a href="https://docs.imajin.ai" className="hover:underline text-gray-400">Docs</a>
        </p>
      </div>
    </div>
  );
}
