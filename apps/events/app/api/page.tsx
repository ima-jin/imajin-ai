export default function APIPage() {
  const endpoints = [
    {
      path: '/api/events',
      methods: [
        { method: 'GET', description: 'List published events' },
        { method: 'POST', description: 'Create event (generates DID + keypair)' },
      ],
    },
    {
      path: '/api/events/[id]',
      methods: [
        { method: 'GET', description: 'Get event details + ticket types + admins' },
        { method: 'PUT', description: 'Update event (auth: creator or admin)' },
      ],
    },
    {
      path: '/api/events/[id]/admins',
      methods: [
        { method: 'GET', description: 'List event admins' },
        { method: 'POST', description: 'Add admin (auth: creator or admin)' },
        { method: 'DELETE', description: 'Remove admin (auth: creator or self)' },
      ],
    },
    {
      path: '/api/events/[id]/hold',
      methods: [
        { method: 'POST', description: 'Hold a ticket (72h default)' },
        { method: 'DELETE', description: 'Release hold' },
      ],
    },
    {
      path: '/api/events/[id]/queue',
      methods: [
        { method: 'GET', description: 'Check queue position' },
        { method: 'POST', description: 'Join ticket queue' },
        { method: 'DELETE', description: 'Leave queue' },
      ],
    },
    {
      path: '/api/events/[id]/tiers',
      methods: [
        { method: 'GET', description: 'List ticket tiers with availability' },
        { method: 'POST', description: 'Create new tier' },
        { method: 'PUT', description: 'Update tier (append-only: price↓, capacity↑, perks+)' },
      ],
    },
    {
      path: '/api/checkout',
      methods: [
        { method: 'POST', description: 'Start ticket purchase (Stripe)' },
      ],
    },
    {
      path: '/api/webhook/payment',
      methods: [
        { method: 'POST', description: 'Stripe webhook for payment confirmation' },
      ],
    },
  ];

  const methodColors: Record<string, string> = {
    GET: 'bg-green-100 text-green-700',
    POST: 'bg-blue-100 text-blue-700',
    PUT: 'bg-yellow-100 text-yellow-700',
    DELETE: 'bg-red-100 text-red-700',
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="text-center mb-12">
        <div className="text-6xl mb-4">🎫</div>
        <h1 className="text-4xl font-bold mb-4">events.imajin.ai</h1>
        <p className="text-xl text-gray-600 dark:text-gray-400">
          Events and ticketing on sovereign infrastructure
        </p>
      </div>

      <div className="grid gap-6 mb-12">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Features</h2>
          <ul className="space-y-2 text-gray-600 dark:text-gray-400">
            <li>✓ Events with DID + keypair (cryptographic identity)</li>
            <li>✓ Multiple ticket tiers with capacity limits</li>
            <li>✓ Append-only tier updates (price↓, capacity↑, perks+)</li>
            <li>✓ Ticket holds (72h reservation)</li>
            <li>✓ Queue system for high-demand events</li>
            <li>✓ Transparent ticket transfers (chain of custody)</li>
            <li>✓ Co-host management (admins)</li>
            <li>✓ Event-signed tickets</li>
          </ul>
        </div>

        <a 
          href="/"
          className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl shadow-lg p-6 text-center transition"
        >
          <span className="text-xl font-semibold">Browse Events →</span>
        </a>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold">API Endpoints</h2>
        </div>
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {endpoints.map((endpoint) => (
            <div key={endpoint.path} className="p-6">
              <code className="text-sm font-mono bg-gray-100 dark:bg-gray-900 px-3 py-1 rounded">
                {endpoint.path}
              </code>
              <div className="mt-4 space-y-2">
                {endpoint.methods.map((m) => (
                  <div key={`${endpoint.path}-${m.method}`} className="flex items-center gap-3">
                    <span className={`px-2 py-1 text-xs font-semibold rounded ${methodColors[m.method]}`}>
                      {m.method}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">{m.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
        <p>Part of the <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a> sovereign network</p>
      </div>
    </div>
  );
}
