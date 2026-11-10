import type { Metadata } from 'next';
import Link from 'next/link';
import { PositionPage } from '@/src/components/www/PositionPage';

const description = 'Identity and authority for AI agents: your runtime, an Imajin plugin and the kernel. See the signed-event boundary and human approvals in alpha.';
export const metadata: Metadata = {
  title: 'How it works',
  description,
  openGraph: { title: 'How it works | Imajin', description, url: '/how-it-works' },
  twitter: { title: 'How it works | Imajin', description },
};

const pillars = [
  {
    title: 'Agent identity',
    summary: 'Your agent acts as itself, not as you.',
    detail: 'Every agent holds its own key and proves it, with no shared passwords or API tokens. Several identities can run on one runtime, each for its own principal. The agent never impersonates the person.',
  },
  {
    title: 'Delegated authority',
    summary: 'You grant authority explicitly and can revoke it.',
    detail: 'Risky actions wait for a named human approver. The record shows both: the person authorised it, and the agent did it.',
  },
  {
    title: 'A signed record and settlement',
    summary: 'Signed actions. Cost and credit per identity.',
    detail: 'Every action is a signed event that anyone can verify, including a third party’s own agent. Cost and credit are recorded per identity, and .fair turns that into who gets paid.',
  },
];

export default function HowItWorksPage() {
  return (
    <PositionPage title="How it works" summary="Your agents act as themselves, on your authority, and every action is signed.">
      <section aria-label="The three pillars" className="grid gap-3 md:grid-cols-3">
        {pillars.map((pillar) => (
          <article key={pillar.title} className="rounded-xl border border-gray-700 bg-gray-900 p-5">
            <h2 className="text-lg font-semibold">{pillar.title}</h2>
            <p className="mt-2 text-sm text-gray-300">{pillar.summary}</p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-amber-400">Details · in alpha</summary>
              <p className="mt-3 leading-relaxed text-gray-300">{pillar.detail}</p>
            </details>
          </article>
        ))}
      </section>

      <section aria-labelledby="flow-heading" className="space-y-4">
        <h2 id="flow-heading" className="text-xl font-semibold">Your runtime. Signed events in. A clear boundary.</h2>
        <figure aria-labelledby="flow-heading" aria-describedby="flow-alternative" className="rounded-xl border border-gray-700 p-5">
          <div aria-hidden="true" className="grid items-center gap-3 text-center md:grid-cols-[1fr_auto_1fr_auto_1fr]">
            <div className="rounded-lg bg-gray-800 p-4 font-semibold">Your agent runtime</div>
            <span className="text-amber-400"><span className="md:hidden">↓</span><span className="hidden md:inline">→</span></span>
            <div className="rounded-lg bg-gray-800 p-4 font-semibold">Imajin plugin</div>
            <div className="text-sm text-amber-400">Signed events<span className="block md:hidden">↓</span><span className="hidden md:block">→</span></div>
            <div className="rounded-lg border border-amber-400 bg-gray-900 p-4">
              <p className="font-semibold">Imajin kernel</p>
              <p className="mt-2 text-sm text-gray-300">Risky action → waits for a named human approver</p>
            </div>
          </div>
          <figcaption id="flow-alternative" className="mt-4 border-t border-gray-700 pt-4 text-sm leading-relaxed text-gray-300">
            Your agent runtime connects through the Imajin plugin to the kernel. Signed events flow in; risky actions wait for a named human approver.
            {' '}The kernel only learns what an agent did through signed events: it never reaches into your runtime, holds session keys or reads transcripts.
          </figcaption>
        </figure>
      </section>

      <section aria-label="How it fits" className="space-y-3">
        <h2 className="text-xl font-semibold">Works with the framework you already run</h2>
        <p className="text-gray-300">OpenClaw today. Hosted or self-run. In alpha.</p>
        <details className="text-sm">
          <summary className="cursor-pointer text-amber-400">How it fits your business</summary>
          <p className="mt-3 max-w-3xl leading-relaxed text-gray-300">
            A plugin for your agent runtime plus the Imajin kernel. The harness is swappable.
            For businesses putting AI agents in front of customers or staff, and platforms and agencies running agents for many clients.
          </p>
        </details>
        <Link href="/compare" className="inline-block text-amber-400 underline underline-offset-4">Compare approaches →</Link>
      </section>
    </PositionPage>
  );
}
