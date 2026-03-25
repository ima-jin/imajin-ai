import Link from 'next/link';
import Image from 'next/image';
import { ImajinFooter } from '@imajin/ui';
import { getClient } from '@imajin/db';
import { PrimitiveMatrix } from '@/components/PrimitiveMatrix';
import matrixData from '../../../docs/matrix-status.json';

// Revalidate stats every 15 minutes (ISR)
export const revalidate = 900;

const MAX_PRESENCES = 1;
const MAX_HUMANS = 5_000;
const MAX_BUSINESSES = 200;

import { buildPublicUrl } from '@imajin/config';

async function getNetworkStats() {
  try {
    const sql = getClient();

    const [presences] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles
      WHERE display_type IN ('presence', 'agent', 'device', 'service')
    `;

    const [humans] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles
      WHERE display_type = 'human'
    `;

    const [businesses] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles
      WHERE display_type = 'org'
    `;

    const [lightningProfiles] = await sql`
      SELECT COUNT(*)::int as count
      FROM auth.identities
      WHERE tier = 'soft'
    `;

    return {
      presences: presences?.count ?? 0,
      humans: humans?.count ?? 0,
      businesses: businesses?.count ?? 0,
      lightning: lightningProfiles?.count ?? 0,
    };
  } catch {
    return { presences: 0, humans: 0, businesses: 0, lightning: 0 };
  }
}

function StatCard({ emoji, count, max, label }: { emoji: string; count: number; max?: number | '∞'; label: string }) {
  const maxDisplay = max === '∞' ? '∞' : max?.toLocaleString();
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-2xl">{emoji}</span>
      <p className="text-lg font-medium text-gray-300">
        {count.toLocaleString()}{maxDisplay != null && <span className="text-gray-600"> / {maxDisplay}</span>}
      </p>
      <p className="text-xs text-gray-600">{label}</p>
    </div>
  );
}

export default async function Home() {
  const stats = await getNetworkStats();

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-20 bg-gray-950">

      {/* HERO */}
      <section className="flex flex-col items-center text-center max-w-2xl mb-20">
        <Image
          src="/images/logo.svg"
          alt="Imajin"
          width={320}
          height={88}
          className="mb-10"
          priority
        />
        <h1 className="text-3xl md:text-5xl font-bold text-gray-100 mb-6">
          The internet that pays you back
        </h1>
        <p className="text-base md:text-lg text-gray-400 leading-relaxed mb-10 max-w-lg">
          imajin.ai is the reference implementation of the{' '}
          <span className="text-amber-400 font-medium">MJN Protocol</span> — an open protocol
          for sovereign human presence. Identity, attribution, and settlement at the protocol layer.
        </p>
        <div className="flex flex-col sm:flex-row gap-4">
          <Link
            href="/whitepaper"
            className="px-6 py-3 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold rounded-md transition-colors"
          >
            Read the Whitepaper
          </Link>
          <Link
            href="/articles"
            className="px-6 py-3 border border-gray-700 hover:border-amber-500/60 text-gray-300 hover:text-amber-400 font-medium rounded-md transition-colors"
          >
            Read the Essays
          </Link>
        </div>
      </section>

      {/* THE MATRIX */}
      <section className="w-full max-w-xl mb-20">
        <div className="text-center mb-8">
          <h2 className="text-xl font-semibold text-gray-200 mb-2">The Protocol Matrix</h2>
          <p className="text-sm text-gray-500">
            4 scopes × 5 primitives. Every problem is a cell. The protocol is the matrix.
          </p>
        </div>
        <PrimitiveMatrix 
          cells={Object.fromEntries(
            Object.entries(matrixData.cells).map(([k, v]) => [k, (v as { percent: number }).percent])
          )}
          overall={Math.round(
            Object.values(matrixData.cells).reduce((sum, v) => sum + (v as { percent: number }).percent, 0) / 
            Object.values(matrixData.cells).length
          )}
        />
      </section>

      {/* NETWORK STATS */}
      <section className="mb-20">
        <p className="text-xs text-gray-600 uppercase tracking-widest text-center mb-6">Network</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 md:gap-10">
          <StatCard emoji="🖥️" count={1} max={1} label="Servers" />
          <StatCard emoji="🟠" count={stats.presences} max={MAX_PRESENCES} label="Presences" />
          <StatCard emoji="🧑" count={stats.humans} max={MAX_HUMANS} label="Humans" />
          <StatCard emoji="🏢" count={stats.businesses} max={MAX_BUSINESSES} label="Businesses" />
          <StatCard emoji="⚡" count={stats.lightning} max="∞" label="Lightning" />
        </div>
      </section>

      {/* THE ESSAYS */}
      <section className="w-full max-w-md mb-20 text-center">
        <Link
          href="/articles"
          className="group block rounded-lg border border-gray-800 hover:border-amber-500/40 p-8 transition-colors"
        >
          <p className="text-4xl font-bold text-gray-100 mb-2 group-hover:text-amber-400 transition-colors">30</p>
          <p className="text-lg font-semibold text-gray-300 mb-1">Essays</p>
          <p className="text-sm text-gray-500">The complete manifesto.</p>
          <p className="text-amber-400 text-sm mt-4 group-hover:text-amber-300 transition-colors">Read all essays →</p>
        </Link>
      </section>

      {/* THE EVENT */}
      <section className="w-full max-w-md mb-20">
        <a
          href={`${buildPublicUrl('events')}/jins-launch-party`}
          className="group block rounded-lg border border-gray-800 hover:border-amber-500/40 p-8 transition-colors text-center"
        >
          <p className="text-xs text-gray-600 uppercase tracking-widest mb-3">April 1, 2026</p>
          <p className="text-lg font-semibold text-gray-200 mb-1 group-hover:text-amber-400 transition-colors">
            Jin's Launch Party
          </p>
          <p className="text-sm text-gray-500 mb-4">The network goes live.</p>
          <p className="text-amber-400 text-sm group-hover:text-amber-300 transition-colors">Get your invite →</p>
        </a>
      </section>

      {/* LINKS */}
      <section className="w-full max-w-md mb-12">
        <p className="text-xs text-gray-600 uppercase tracking-widest text-center mb-6">Explore</p>
        <div className="flex flex-col gap-3 text-sm">
          <Link href="/whitepaper" className="flex justify-between items-center text-gray-400 hover:text-amber-400 transition-colors py-1 border-b border-gray-900">
            <span>Whitepaper</span>
            <span className="text-gray-700">→</span>
          </Link>
          <a href="https://github.com/ima-jin/imajin-ai" target="_blank" rel="noopener noreferrer" className="flex justify-between items-center text-gray-400 hover:text-amber-400 transition-colors py-1 border-b border-gray-900">
            <span>GitHub — imajin-ai</span>
            <span className="text-gray-700">→</span>
          </a>
          <a href="https://github.com/ima-jin/mjn-protocol" target="_blank" rel="noopener noreferrer" className="flex justify-between items-center text-gray-400 hover:text-amber-400 transition-colors py-1 border-b border-gray-900">
            <span>Protocol Spec — mjn-protocol</span>
            <span className="text-gray-700">→</span>
          </a>
          <a href={`${buildPublicUrl('coffee')}/b0b`} className="flex justify-between items-center text-gray-400 hover:text-amber-400 transition-colors py-1 border-b border-gray-900">
            <span>Buy us a coffee</span>
            <span className="text-gray-700">→</span>
          </a>
          <a href={`${buildPublicUrl('registry')}/docs`} className="flex justify-between items-center text-gray-400 hover:text-amber-400 transition-colors py-1 border-b border-gray-900">
            <span>API Docs</span>
            <span className="text-gray-700">→</span>
          </a>
          <a href={buildPublicUrl('market')} className="flex justify-between items-center text-gray-400 hover:text-amber-400 transition-colors py-1 border-b border-gray-900">
            <span>Market</span>
            <span className="text-gray-700">→</span>
          </a>
        </div>
      </section>

      {/* RFC CALLOUT */}
      <section className="w-full max-w-md mb-16">
        <a
          href="https://github.com/ima-jin/imajin-ai/discussions/categories/ideas"
          target="_blank"
          rel="noopener noreferrer"
          className="group block rounded-lg border border-gray-700 hover:border-amber-500/50 p-6 transition-colors text-center"
        >
          <p className="text-lg font-semibold text-gray-200 mb-2 group-hover:text-amber-400 transition-colors">
            Help us build this
          </p>
          <p className="text-sm text-gray-400 leading-relaxed">
            We have open Requests for Comment on features we're building.
            Read, discuss, and shape what comes next.
          </p>
          <p className="text-amber-400 text-sm mt-3 group-hover:text-amber-300 transition-colors">
            Join the conversation →
          </p>
        </a>
      </section>

      {/* FOOTER */}
      <footer className="mt-auto pt-4 pb-8">
        <ImajinFooter />
      </footer>
    </main>
  );
}
