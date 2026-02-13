/**
 * pay.imajin.ai landing page
 */

export default function Home() {
  return (
    <main style={{ 
      fontFamily: 'system-ui, sans-serif',
      maxWidth: '800px',
      margin: '0 auto',
      padding: '2rem',
    }}>
      <h1>🟠 Imajin Pay</h1>
      <p>Unified payment infrastructure for the sovereign stack.</p>
      
      <h2>API Endpoints</h2>
      
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #333' }}>
            <th style={{ textAlign: 'left', padding: '0.5rem' }}>Method</th>
            <th style={{ textAlign: 'left', padding: '0.5rem' }}>Endpoint</th>
            <th style={{ textAlign: 'left', padding: '0.5rem' }}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <td style={{ padding: '0.5rem' }}><code>GET</code></td>
            <td style={{ padding: '0.5rem' }}><code>/api/health</code></td>
            <td style={{ padding: '0.5rem' }}>Health check for all providers</td>
          </tr>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <td style={{ padding: '0.5rem' }}><code>POST</code></td>
            <td style={{ padding: '0.5rem' }}><code>/api/checkout</code></td>
            <td style={{ padding: '0.5rem' }}>Create hosted Stripe Checkout</td>
          </tr>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <td style={{ padding: '0.5rem' }}><code>POST</code></td>
            <td style={{ padding: '0.5rem' }}><code>/api/charge</code></td>
            <td style={{ padding: '0.5rem' }}>Direct payment (Stripe or Solana)</td>
          </tr>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <td style={{ padding: '0.5rem' }}><code>POST</code></td>
            <td style={{ padding: '0.5rem' }}><code>/api/escrow</code></td>
            <td style={{ padding: '0.5rem' }}>Create escrow (hold funds)</td>
          </tr>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <td style={{ padding: '0.5rem' }}><code>PUT</code></td>
            <td style={{ padding: '0.5rem' }}><code>/api/escrow</code></td>
            <td style={{ padding: '0.5rem' }}>Release or refund escrow</td>
          </tr>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <td style={{ padding: '0.5rem' }}><code>POST</code></td>
            <td style={{ padding: '0.5rem' }}><code>/api/webhook</code></td>
            <td style={{ padding: '0.5rem' }}>Stripe webhook handler</td>
          </tr>
        </tbody>
      </table>
      
      <h2>Providers</h2>
      <ul>
        <li><strong>Stripe</strong> — USD, CAD, EUR, GBP (fiat)</li>
        <li><strong>Solana</strong> — SOL, USDC, MJN (crypto)</li>
      </ul>
      
      <h2>Example: Create Checkout</h2>
      <pre style={{ 
        background: '#f5f5f5', 
        padding: '1rem', 
        borderRadius: '4px',
        overflow: 'auto',
      }}>
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
      
      <h2>Example: Direct Charge</h2>
      <pre style={{ 
        background: '#f5f5f5', 
        padding: '1rem', 
        borderRadius: '4px',
        overflow: 'auto',
      }}>
{`POST /api/charge
Content-Type: application/json

{
  "amount": 100000000,
  "currency": "SOL",
  "to": { "solanaAddress": "xxx..." }
}

→ { "id": "sol-pending-xxx", "status": "requires_action", ... }`}
      </pre>
      
      <footer style={{ marginTop: '3rem', color: '#666', fontSize: '0.9rem' }}>
        <p>Part of the <a href="https://imajin.ai">Imajin</a> sovereign stack.</p>
      </footer>
    </main>
  );
}
