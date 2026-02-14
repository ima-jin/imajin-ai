export default function Home() {
  return (
    <main style={{ 
      fontFamily: 'system-ui, sans-serif',
      maxWidth: '800px',
      margin: '0 auto',
      padding: '2rem',
    }}>
      <h1>🌐 Imajin Registry</h1>
      <p style={{ color: '#666', fontSize: '1.2rem' }}>
        The phone book for the sovereign network.
      </p>

      <section style={{ marginTop: '2rem' }}>
        <h2>API Endpoints</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem' }}>Method</th>
              <th style={{ padding: '0.5rem' }}>Endpoint</th>
              <th style={{ padding: '0.5rem' }}>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem' }}><code>POST</code></td>
              <td style={{ padding: '0.5rem' }}><code>/api/node/register</code></td>
              <td style={{ padding: '0.5rem' }}>Register a new node</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem' }}><code>POST</code></td>
              <td style={{ padding: '0.5rem' }}><code>/api/node/heartbeat</code></td>
              <td style={{ padding: '0.5rem' }}>Send liveness ping</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem' }}><code>GET</code></td>
              <td style={{ padding: '0.5rem' }}><code>/api/node/list</code></td>
              <td style={{ padding: '0.5rem' }}>List all nodes</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem' }}><code>GET</code></td>
              <td style={{ padding: '0.5rem' }}><code>/api/node/lookup/:id</code></td>
              <td style={{ padding: '0.5rem' }}>Find node by DID or hostname</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem' }}><code>POST</code></td>
              <td style={{ padding: '0.5rem' }}><code>/api/builds/verify</code></td>
              <td style={{ padding: '0.5rem' }}>Check if build hash is approved</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>How It Works</h2>
        <ol style={{ lineHeight: '1.8' }}>
          <li>Run a signed Imajin build (auth, pay, profile, etc.)</li>
          <li>Your node generates a keypair and creates a DID</li>
          <li>Node sends attestation to <code>/api/node/register</code></li>
          <li>Registry verifies build hash against approved releases</li>
          <li>If valid, provisions <code>your-hostname.imajin.ai</code></li>
          <li>Node sends daily heartbeats to stay active</li>
          <li>Registration renews every 30 days</li>
        </ol>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Federation Note</h2>
        <p style={{ color: '#666' }}>
          This registry is <strong>federated, not decentralized</strong>. 
          It&apos;s a bootstrapping convenience. The path to full decentralization 
          includes on-chain node registry (Solana) and mesh trust discovery 
          (optical verification between devices).
        </p>
        <p style={{ color: '#666' }}>
          The exit door is always open: this registry is open source, 
          and nodes work locally even without a subdomain.
        </p>
      </section>

      <footer style={{ marginTop: '3rem', paddingTop: '1rem', borderTop: '1px solid #eee', color: '#999' }}>
        <p>
          <a href="https://github.com/ima-jin/imajin-ai" style={{ color: '#0066cc' }}>GitHub</a>
          {' · '}
          <a href="https://imajin.ai" style={{ color: '#0066cc' }}>imajin.ai</a>
        </p>
      </footer>
    </main>
  );
}
