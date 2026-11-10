import Link from 'next/link';
import type { ReactNode } from 'react';

const positionLinkClass = 'rounded-md px-4 py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400';

export function PositionPage({ title, summary, children }: Readonly<{
  title: string;
  summary: string;
  children: ReactNode;
}>) {
  return (
    <main className="min-h-screen bg-gray-950 px-6 pb-12 pt-12 text-gray-100 sm:pt-16">
      <div className="mx-auto max-w-5xl space-y-10">
        <header className="max-w-3xl space-y-3">
          <Link href="/" className="text-sm text-amber-400 underline underline-offset-4">Imajin</Link>
          <p className="text-sm font-medium uppercase tracking-widest text-amber-400">Alpha · The trust layer for AI agents</p>
          <h1 className="text-3xl font-bold sm:text-5xl">{title}</h1>
          <p className="text-lg leading-relaxed text-gray-300">{summary}</p>
        </header>
        {children}
        <footer className="space-y-4 border-t border-gray-700 pt-6">
          <h2 className="text-xl font-semibold">Join the alpha</h2>
          <p className="text-sm text-gray-300">For testers, integrators and partners. Joining the alpha is the sign-up path today.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/alpha" className={`${positionLinkClass} bg-amber-400 text-gray-950 hover:bg-amber-300`}>Join the alpha</Link>
            <Link href="/alpha?intent=demo" className={`${positionLinkClass} border border-gray-500 hover:border-amber-400`}>Book a demo</Link>
            <Link href="/docs" className={`${positionLinkClass} text-amber-400 underline underline-offset-4`}>Read the docs</Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
