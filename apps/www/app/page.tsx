import Link from 'next/link';
import Image from 'next/image';

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-16">
      {/* Logo */}
      <Image
        src="/images/logo-kanji.svg"
        alt="今人"
        width={120}
        height={120}
        className="mb-8"
        priority
      />
      
      {/* Wordmark */}
      <Image
        src="/images/logo.svg"
        alt="Imajin"
        width={280}
        height={80}
        className="mb-12"
        priority
      />
      
      {/* Core message */}
      <div className="max-w-2xl text-center space-y-6 mb-12">
        <p className="text-xl md:text-2xl text-gray-200">
          Sovereign infrastructure for identity, payments, and attribution.
        </p>
        <p className="text-gray-400">
          Not a social network. Not a platform. Just plumbing — so the value you create stays yours.
        </p>
        <p className="text-gray-500 text-sm">
          Own your identity. Own your data. Own your devices.
        </p>
      </div>

      {/* The story link */}
      <Link
        href="/articles/the-internet-we-lost"
        className="text-orange-400 hover:text-orange-300 transition-colors mb-12"
      >
        Read the story →
      </Link>
      
      {/* CTA */}
      <Link
        href="/register"
        className="px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors"
      >
        Get Updates
      </Link>

      {/* Event teaser */}
      <p className="mt-16 text-sm text-gray-600">
        Jin's Launch Party — April 1st, 2026
      </p>
      
      {/* Footer */}
      <footer className="absolute bottom-8 text-sm text-gray-600">
        Toronto, Canada
      </footer>
    </main>
  );
}
