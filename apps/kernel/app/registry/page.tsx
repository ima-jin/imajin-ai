import { ImajinFooter } from '@imajin/ui';

export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="text-6xl mb-4">📡</div>
      <h1 className="text-4xl font-bold mb-4 text-primary font-mono">
        registry.imajin.ai
      </h1>
      
      <p className="text-xl text-secondary mb-8">
        The phone book for the sovereign network.
        <br />
        Register your node, get a subdomain.
      </p>

      <div className="bg-[#0a0a0a] border border-white/10 p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4 text-primary font-mono">How It Works</h2>
        
        <ol className="text-left space-y-2 text-secondary">
          <li><span className="text-[#F59E0B] font-bold">1.</span> Run a signed Imajin build</li>
          <li><span className="text-[#F59E0B] font-bold">2.</span> Node generates keypair and DID</li>
          <li><span className="text-[#F59E0B] font-bold">3.</span> Registry verifies build attestation</li>
          <li><span className="text-[#F59E0B] font-bold">4.</span> Get your-hostname.imajin.ai</li>
          <li><span className="text-[#F59E0B] font-bold">5.</span> Send daily heartbeats to stay active</li>
        </ol>
      </div>

      <div className="bg-[#0a0a0a] border border-white/10 p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4 text-primary font-mono">DFOS Relay</h2>
        <p className="text-secondary mb-4">
          This registry is also a <a href="https://dfos.com" className="text-[#F59E0B] hover:underline">DFOS</a> relay node — 
          syncing identity chains and content proofs across the network.
        </p>
        <div className="text-left space-y-2 text-secondary">
          <p><span className="text-[#F59E0B] font-bold">→</span> Chain-backed identity verification</p>
          <p><span className="text-[#F59E0B] font-bold">→</span> Cryptographic proof relay</p>
          <p><span className="text-[#F59E0B] font-bold">→</span> Self-certifying DIDs via DFOS substrate</p>
        </div>
      </div>

      <div className="bg-[#0a0a0a] border border-white/10 p-6 mb-8">
        <a 
          href="/docs" 
          className="text-[#F59E0B] hover:underline text-lg font-semibold"
        >
          Global API Specification →
        </a>
        <p className="text-secondary text-sm mt-2">
          Browse the full API for all Imajin services
        </p>
      </div>

      <ImajinFooter />
    </div>
  );
}
