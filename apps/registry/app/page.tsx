export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="text-6xl mb-4">📡</div>
      <h1 className="text-4xl font-bold mb-4 text-white">
        registry.imajin.ai
      </h1>
      
      <p className="text-xl text-gray-400 mb-8">
        The phone book for the sovereign network.
        <br />
        Register your node, get a subdomain.
      </p>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4 text-white">How It Works</h2>
        
        <ol className="text-left space-y-2 text-gray-400">
          <li><span className="text-[#F59E0B] font-bold">1.</span> Run a signed Imajin build</li>
          <li><span className="text-[#F59E0B] font-bold">2.</span> Node generates keypair and DID</li>
          <li><span className="text-[#F59E0B] font-bold">3.</span> Registry verifies build attestation</li>
          <li><span className="text-[#F59E0B] font-bold">4.</span> Get your-hostname.imajin.ai</li>
          <li><span className="text-[#F59E0B] font-bold">5.</span> Send daily heartbeats to stay active</li>
        </ol>
      </div>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-6 mb-8">
        <a 
          href="/docs" 
          className="text-[#F59E0B] hover:underline text-lg font-semibold"
        >
          Global API Specification →
        </a>
        <p className="text-gray-500 text-sm mt-2">
          Browse the full API for all Imajin services
        </p>
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
