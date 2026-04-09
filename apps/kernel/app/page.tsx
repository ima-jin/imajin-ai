import Image from 'next/image';
import { ImajinFooter } from '@imajin/ui';
import { getClient } from '@imajin/db';
import { SERVICES } from '@imajin/config';
import { LandingGrid, EmailCapture } from '@/src/components/www/LandingGrid';
import { PromoVideo } from '@/src/components/www/PromoVideo';
import { BugReportButton } from '@/src/components/www/bug-report-button';

// Revalidate stats every 15 minutes (ISR)
export const revalidate = 900;

async function getNetworkStats() {
  try {
    const sql = getClient();

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

    const [presences] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles
      WHERE display_type IN ('presence', 'agent', 'device', 'service')
    `;

    return {
      humans: humans?.count ?? 0,
      businesses: businesses?.count ?? 0,
      presences: presences?.count ?? 0,
    };
  } catch {
    return { humans: 0, businesses: 0, presences: 0 };
  }
}

export default async function Home() {
  const stats = await getNetworkStats();

  const totalIdentities = stats.humans + stats.businesses + stats.presences;
  const serviceCount = SERVICES.filter((s) => s.visibility !== 'internal').length;
  const daysSinceLaunch = Math.floor((Date.now() - new Date('2026-02-01').getTime()) / (1000 * 60 * 60 * 24));

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 bg-gray-950">

      {/* LOGO + TAGLINE */}
      <section className="flex flex-col items-center text-center mb-12">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-2">
          <span className="text-3xl font-bold text-amber-500">人</span>
        </div>
        <p className="text-base text-gray-500">The sovereign browser.</p>
      </section>

      {/* PROMO VIDEO */}
      <PromoVideo />

      {/* EMAIL CAPTURE — directly below video */}
      <section className="mb-16 text-center">
        <EmailCapture />
      </section>

      {/* LAUNCHER GRID */}
      <section className="w-full max-w-2xl mb-16">
        <LandingGrid />
      </section>

      {/* FOOTER */}
      <footer className="mt-auto pt-4 pb-8">
        <ImajinFooter />
      </footer>
      <BugReportButton />
    </main>
  );
}
