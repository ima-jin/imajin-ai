export default function HomePage() {
  return (
    <div className="max-w-2xl mx-auto py-16 text-center">
      <h1 className="text-4xl font-bold text-white mb-4">Media Service</h1>
      <p className="text-gray-400 mb-8">
        DID-pegged file storage for the sovereign network.
      </p>
      <div className="inline-flex items-center gap-2 px-4 py-2 bg-orange-500/10 border border-orange-500/30 rounded-lg text-orange-400 text-sm">
        <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
        API available at <code className="font-mono">/api/assets</code>
      </div>
    </div>
  );
}
