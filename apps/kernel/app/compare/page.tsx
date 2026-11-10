import type { Metadata } from 'next';
import Link from 'next/link';
import { PositionPage } from '@/src/components/www/PositionPage';

const description = 'Where Imajin fits alongside identity platforms, agent frameworks, hosted assistants and web3 agent projects. The trust layer for AI agents, in alpha.';
export const metadata: Metadata = {
  title: 'Compare',
  description,
  openGraph: { title: 'Compare | Imajin', description, url: '/compare' },
  twitter: { title: 'Compare | Imajin', description },
};

const comparisons = [
  {
    name: 'Identity incumbents',
    focus: 'People logging into apps.',
    fit: 'Identity and authority for agents acting for people.',
    detail: 'Identity platforms were built for people logging into apps, not for agents acting for people.',
  },
  {
    name: 'Agent frameworks',
    focus: 'They orchestrate. They are good at doing things.',
    fit: 'Imajin is the accountability layer under them. You use both.',
    detail: 'Who did this, on whose authority, and who gets paid? Imajin works with the framework you already run (OpenClaw today).',
  },
  {
    name: 'Hosted assistants',
    focus: 'Hosted identity, memory and logs.',
    fit: 'Rented; you don’t own the record. Imajin: a signed record, hosted or self-run.',
    detail: 'Hosted assistants own the identity, the memory and the logs. Every action in Imajin is a signed event that anyone can verify.',
  },
  {
    name: 'Web3 agent projects',
    focus: 'Agent projects in web3.',
    fit: 'Imajin starts from working software.',
    detail: 'Agent identity, delegated authority, and a signed record and settlement — in alpha.',
  },
];

export default function ComparePage() {
  return (
    <PositionPage title="Compare" summary="Identity and authority for AI agents. An accountability layer alongside the framework you already run.">
      <section aria-label="Four approaches compared" className="space-y-3">
        <div className="hidden grid-cols-3 gap-6 px-5 text-sm font-medium text-gray-300 md:grid" aria-hidden="true">
          <span>Approach</span><span>What it does / focus</span><span>Where Imajin fits · in alpha</span>
        </div>
        {comparisons.map((comparison) => (
          <article key={comparison.name} className="rounded-xl border border-gray-700 bg-gray-900 p-5">
            <div className="grid gap-3 md:grid-cols-3 md:gap-6">
              <h2 className="text-lg font-semibold">{comparison.name}</h2>
              <p className="text-sm leading-relaxed text-gray-300"><span className="font-medium text-gray-100 md:sr-only">Focus: </span>{comparison.focus}</p>
              <p className="text-sm leading-relaxed text-gray-300"><span className="font-medium text-gray-100 md:sr-only">Imajin in alpha: </span>{comparison.fit}</p>
            </div>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-amber-400">More on {comparison.name.toLowerCase()}</summary>
              <p className="mt-3 max-w-3xl leading-relaxed text-gray-300">{comparison.detail}</p>
            </details>
          </article>
        ))}
      </section>
      <Link href="/how-it-works" className="inline-block text-amber-400 underline underline-offset-4">How it works →</Link>
    </PositionPage>
  );
}
