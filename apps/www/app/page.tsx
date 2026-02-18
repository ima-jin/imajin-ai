import Link from 'next/link';
import Image from 'next/image';

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-16">
      {/* Logo */}
      <Image
        src="/images/logo-kanji.svg"
        alt="今人"
        width={180}
        height={180}
        className="mb-8"
        priority
      />
      
      {/* Wordmark */}
      <Image
        src="/images/logo.svg"
        alt="Imajin"
        width={420}
        height={120}
        className="mb-12"
        priority
      />
      
      {/* Core message */}
      <div className="max-w-2xl text-center space-y-6 mb-12">
        <p className="text-xl md:text-2xl text-gray-200">
          Sovereign infrastructure for identity, payments, attribution, and more.
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
        className="text-orange-400 hover:text-orange-300 transition-colors mb-8"
      >
        Read the story →
      </Link>
      
      {/* Discord - with self-awareness */}
      <div className="text-center mb-12">
        <a
          href="https://discord.gg/6hkQW3uw4m"
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-400 hover:text-gray-300 transition-colors"
        >
          Join the Discord
        </a>
        <p className="text-gray-600 text-xs mt-1">
          We know. This is the exit.
        </p>
      </div>
      
      {/* CTA */}
      <Link
        href="/register"
        className="px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors"
      >
        Get Updates
      </Link>

      {/* Support */}
      <a
        href="https://coffee.imajin.ai"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 text-gray-500 hover:text-orange-400 transition-colors text-sm"
      >
        Support this work →
      </a>

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
