export default function ConnectionsHome() {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Connections</h1>
      <p className="text-gray-400 mb-8">
        Your pods and trust-based connections on the Imajin network.
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="bg-white/5 rounded-lg p-6 border border-white/10">
          <h2 className="text-xl font-semibold mb-3">My Pods</h2>
          <p className="text-gray-400 text-sm">
            Create and manage your trust pods — private groups where you control membership.
          </p>
        </section>

        <section className="bg-white/5 rounded-lg p-6 border border-white/10">
          <h2 className="text-xl font-semibold mb-3">My Connections</h2>
          <p className="text-gray-400 text-sm">
            People you share a direct pod with — your inner circle.
          </p>
        </section>
      </div>
    </div>
  );
}
