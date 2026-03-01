export default function Home() {
  return (
    <div className="max-w-2xl mx-auto text-center py-16">
      <div className="text-6xl mb-6">🧠</div>
      <h1 className="text-4xl font-bold mb-4 text-white">
        Imajin <span className="text-[#F59E0B]">Learn</span>
      </h1>
      <p className="text-xl text-gray-400 mb-8">
        AI workshops for humans. No hype, just skills.
      </p>
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 mb-8">
        <h2 className="text-xl font-semibold mb-3 text-white">Intro to AI</h2>
        <p className="text-gray-400 mb-4">
          3-hour hands-on workshop. Learn to use AI as a tool, not a replacement.
          Build real things. Ask hard questions. Leave with skills.
        </p>
        <div className="flex justify-center gap-6 text-sm text-gray-500">
          <span>⏱ 3 hours</span>
          <span>👥 16 max</span>
          <span>💰 $250/person</span>
        </div>
      </div>
      <p className="text-gray-500 text-sm">Sessions coming soon.</p>
    </div>
  );
}
