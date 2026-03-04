import Link from 'next/link';
import Image from 'next/image';
import { ImajinFooter } from '@imajin/ui';
import { getClient } from '@imajin/db';

const MAX_PRESENCES = 1;
const MAX_HUMANS = 5_000;
const MAX_BUSINESSES = 200;

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

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
      FROM profile.profiles 
      WHERE identity_tier = 'soft'
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
    <div className="flex flex-col items-center gap-2">
      <span className="text-3xl">{emoji}</span>
      <p className="text-xl font-medium text-gray-200">
        {count.toLocaleString()}{maxDisplay != null && <span className="text-gray-500"> / {maxDisplay}</span>}
      </p>
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}

export default async function Home() {
  const stats = await getNetworkStats();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-16">
      {/* Wordmark */}
      <Image
        src="/images/logo.svg"
        alt="Imajin"
        width={360}
        height={100}
        className="mb-10"
        priority
      />

      {/* Tagline */}
      <h1 className="text-2xl md:text-4xl font-bold text-gray-200 text-center mb-16">
        The internet that pays you back
      </h1>

      {/* Network stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12 mb-16">
        <StatCard emoji="🟠" count={stats.presences} max={MAX_PRESENCES} label="Presences" />
        <StatCard emoji="🧑" count={stats.humans} max={MAX_HUMANS} label="Humans" />
        <StatCard emoji="🏢" count={stats.businesses} max={MAX_BUSINESSES} label="Businesses" />
        <StatCard emoji="⚡" count={stats.lightning} max="∞" label="Lightning" />
      </div>

      {/* Links */}
      <div className="flex flex-col items-center gap-4">
        <Link
          href="/articles"
          className="text-orange-400 hover:text-orange-300 transition-colors"
        >
          Read the articles →
        </Link>
        <a
          href={`${PREFIX}coffee.${DOMAIN}/veteze`}
          className="text-orange-400 hover:text-orange-300 transition-colors"
        >
          Support this effort →
        </a>
        <a
          href={`${PREFIX}events.${DOMAIN}/jins-launch-party`}
          className="text-orange-400 hover:text-orange-300 transition-colors"
        >
          Jin's Launch Party →
        </a>
      </div>

      {/* Shared footer */}
      <footer className="mt-auto pt-16 pb-8">
        <ImajinFooter />
      </footer>
    </main>
  );
}
