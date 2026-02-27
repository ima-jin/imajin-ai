export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="text-6xl mb-4">💰</div>
      <h1 className="text-4xl font-bold mb-4 text-white">
        pay.imajin.ai
      </h1>
      
      <p className="text-xl text-gray-400 mb-8">
        Unified payment infrastructure for the sovereign stack.
        <br />
        Stripe + Solana. Your keys, your money.
      </p>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4 text-white">API Endpoints</h2>
        
        <div className="text-left space-y-3 font-mono text-sm">
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-blue-500 font-bold">GET</span> /api/health
            <span className="text-gray-500 ml-2">— Health check for all providers</span>
          </div>
          
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/checkout
            <span className="text-gray-500 ml-2">— Create hosted Stripe Checkout</span>
          </div>
          
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/charge
            <span className="text-gray-500 ml-2">— Direct payment (Stripe or Solana)</span>
          </div>
          
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/escrow
            <span className="text-gray-500 ml-2">— Create escrow (hold funds)</span>
          </div>
          
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-yellow-500 font-bold">PUT</span> /api/escrow
            <span className="text-gray-500 ml-2">— Release or refund escrow</span>
          </div>
          
          <div className="p-3 bg-black/50 border border-gray-800 rounded">
            <span className="text-green-500 font-bold">POST</span> /api/webhook
            <span className="text-gray-500 ml-2">— Stripe webhook handler</span>
          </div>
        </div>
      </div>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-8 mb-8">
        <h2 className="text-2xl font-semibold mb-4 text-white">Providers</h2>
        
        <div className="grid grid-cols-2 gap-4 text-left">
          <div className="p-4 bg-gray-900 border border-gray-800 rounded">
            <div className="text-lg font-semibold mb-2">💳 Stripe</div>
            <p className="text-gray-500 text-sm">USD, CAD, EUR, GBP (fiat)</p>
          </div>
          <div className="p-4 bg-gray-900 border border-gray-800 rounded">
            <div className="text-lg font-semibold mb-2">◎ Solana</div>
            <p className="text-gray-500 text-sm">SOL, USDC, MJN (crypto)</p>
          </div>
        </div>
      </div>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-8 mb-8 text-left">
        <h2 className="text-2xl font-semibold mb-4 text-center text-white">Example: Create Checkout</h2>
        
        <pre className="p-4 bg-black/50 border border-gray-800 rounded text-sm overflow-auto">
{`POST /api/checkout
Content-Type: application/json

{
  "items": [
    { "name": "Unit 8×8×8", "amount": 49900, "quantity": 1 }
  ],
  "currency": "USD",
  "successUrl": "https://example.com/success",
  "cancelUrl": "https://example.com/cancel"
}

→ { "id": "cs_xxx", "url": "https://checkout.stripe.com/..." }`}
        </pre>
      </div>

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-xl p-8 mb-8 text-left">
        <h2 className="text-2xl font-semibold mb-4 text-center text-white">Example: Direct Charge</h2>
        
        <pre className="p-4 bg-black/50 border border-gray-800 rounded text-sm overflow-auto">
{`POST /api/charge
Content-Type: application/json

{
  "amount": 100000000,
  "currency": "SOL",
  "to": { "solanaAddress": "xxx..." }
}

→ { "id": "sol-pending-xxx", "status": "requires_action", ... }`}
        </pre>
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
