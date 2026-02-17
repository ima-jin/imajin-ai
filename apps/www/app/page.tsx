import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      {/* Orb */}
      <div className="w-24 h-24 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 shadow-[0_0_60px_rgba(255,107,53,0.4)] mb-12" />
      
      {/* Title */}
      <h1 className="text-5xl md:text-6xl font-light tracking-tight mb-4">
        今人
      </h1>
      <p className="text-xl md:text-2xl text-gray-400 mb-8">
        Imajin
      </p>
      
      {/* Tagline */}
      <p className="text-lg md:text-xl text-gray-300 text-center max-w-xl mb-12">
        Sovereign technology for humans and machines.
        <br />
        <span className="text-gray-500">Own your data. Own your identity. Own your devices.</span>
      </p>
      
      {/* CTA */}
      <Link
        href="/register"
        className="px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors"
      >
        Get Updates
      </Link>
      
      {/* Footer */}
      <footer className="absolute bottom-8 text-sm text-gray-600">
        Toronto, Canada
      </footer>
    </main>
  );
}
