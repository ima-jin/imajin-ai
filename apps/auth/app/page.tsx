export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white p-8 max-w-4xl mx-auto">
      <h1 className="text-5xl font-bold mb-4">
        Imajin <span className="text-orange-500">Auth</span>
      </h1>
      <p className="text-xl text-gray-400 mb-8">
        Sovereign identity for humans and agents
      </p>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold mb-4">What is this?</h2>
        <p className="text-gray-300 mb-4">
          A simple identity service. No passwords, no OAuth, no email verification required.
        </p>
        <p className="text-gray-300">
          You have a keypair. You sign a challenge. You get a token. That's it.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold mb-4">How it works</h2>
        <ol className="list-decimal list-inside space-y-2 text-gray-300">
          <li><strong>Register</strong> — Submit your public key, get a DID</li>
          <li><strong>Challenge</strong> — Request a random string to sign</li>
          <li><strong>Authenticate</strong> — Sign the challenge, get a token</li>
          <li><strong>Use</strong> — Include token in your requests</li>
        </ol>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold mb-4">API Endpoints</h2>
        <div className="space-y-4 font-mono text-sm">
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-orange-500">POST /api/register</div>
            <div className="text-gray-500">Register a new identity with your public key</div>
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-orange-500">POST /api/challenge</div>
            <div className="text-gray-500">Get a challenge to sign for authentication</div>
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-orange-500">POST /api/authenticate</div>
            <div className="text-gray-500">Submit signed challenge, receive token</div>
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-orange-500">POST /api/validate</div>
            <div className="text-gray-500">Validate a token (for apps)</div>
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-orange-500">POST /api/verify</div>
            <div className="text-gray-500">Verify a signed message directly</div>
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-orange-500">GET /api/lookup/:id</div>
            <div className="text-gray-500">Look up identity by DID</div>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold mb-4">Identity Types</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-lg font-semibold mb-2">👤 Human</div>
            <p className="text-gray-400 text-sm">
              A person. Has a keypair, signs things, uses apps.
            </p>
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg">
            <div className="text-lg font-semibold mb-2">🤖 Agent</div>
            <p className="text-gray-400 text-sm">
              An AI or bot. Same auth, different type tag. Always labeled.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Why?</h2>
        <p className="text-gray-300 mb-4">
          Auth is over-engineered. OAuth flows, password resets, email verification,
          session management, refresh tokens... it's a mess.
        </p>
        <p className="text-gray-300">
          Cryptographic identity is simple: if you can sign with a key, you are that key.
          Everything else is optional complexity.
        </p>
      </section>

      <footer className="mt-16 pt-8 border-t border-zinc-800 text-center text-gray-500 text-sm">
        <p>
          Part of the{' '}
          <a href="https://imajin.ai" className="text-orange-500 hover:text-orange-400">
            Imajin
          </a>{' '}
          ecosystem
        </p>
      </footer>
    </main>
  );
}
