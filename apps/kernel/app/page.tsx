import { ImajinFooter } from '@imajin/ui';
import { APP_DISPLAY_NAME } from '@imajin/config';
import { getClient } from '@imajin/db';
import { LandingGrid, EmailCapture } from '@/src/components/www/LandingGrid';
import { PromoVideo } from '@/src/components/www/PromoVideo';
import { PrimitiveMatrix } from '@/src/components/www/PrimitiveMatrix';
import { toMatrixProps } from '@/src/components/www/matrix';
import { BugReportButton } from '@/src/components/www/bug-report-button';
import matrixData from '../../../docs/matrix-status.json';

// Revalidate stats every 15 minutes (ISR)
export const revalidate = 900;

async function getNetworkStats() {
  try {
    const sql = getClient();

    const [humans] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles p
      JOIN auth.identities i ON i.id = p.did
      WHERE i.scope = 'actor' AND i.subtype = 'human'
    `;

    const [businesses] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles p
      JOIN auth.identities i ON i.id = p.did
      WHERE i.scope IN ('business', 'community', 'family')
    `;

    const [presences] = await sql`
      SELECT COUNT(*)::int as count
      FROM profile.profiles p
      JOIN auth.identities i ON i.id = p.did
      WHERE i.scope = 'actor' AND i.subtype IN ('presence', 'agent', 'device')
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
  await getNetworkStats();

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 bg-gray-950">

      {/* LOGO + HERO */}
      <section className="flex flex-col items-center text-center mb-12 max-w-2xl">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-4">
          <span className="text-3xl font-bold text-amber-500">人</span>
        </div>
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">{APP_DISPLAY_NAME} — programmable trust.</p>
        <h1 className="text-2xl md:text-4xl font-bold text-gray-100 leading-tight">
          You compose. {APP_DISPLAY_NAME} orchestrates. Signed. Legible.
        </h1>
        <p className="text-base text-gray-500 italic mt-3">the speed of thought, signed.</p>
      </section>

      {/* PROMO VIDEO */}
      <PromoVideo />

      {/* EMAIL CAPTURE — directly below video */}
      <section className="mb-16 text-center">
        <EmailCapture />
      </section>

      {/* THE PROTOCOL MATRIX */}
      <section className="w-full max-w-2xl mb-16">
        <div className="text-center mb-8">
          <h2 className="text-xl font-semibold text-gray-200 mb-3">The Protocol Matrix</h2>
          <p className="text-sm text-gray-500 leading-relaxed">
            The matrix is the substrate&apos;s vocabulary — the verbs any intent resolves to,
            the same whether the actor is a person, a family, or a community. The agent
            doesn&apos;t invent capabilities; it composes these cells on your behalf. Identity
            isn&apos;t a cell — it&apos;s the primitive that stretches across every scope.
          </p>
        </div>
        <PrimitiveMatrix {...toMatrixProps(matrixData)} />
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
