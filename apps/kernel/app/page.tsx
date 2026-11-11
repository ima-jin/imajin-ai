import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { domainFromHost, domainLanding } from '@/src/lib/domains/routing';

const pillars = [
  {
    title: 'Agent identity',
    summary: 'The agent never impersonates the person.',
    detail: 'Every agent holds its own key and proves it, with no shared passwords or API tokens. Several identities can run on one runtime, each for its own principal.',
  },
  {
    title: 'Delegated authority',
    summary: 'A person grants authority explicitly and can revoke it.',
    detail: 'Risky actions wait for a named human approver. The record shows both: the person authorised it, and the agent did it.',
  },
  {
    title: 'A signed record and settlement',
    summary: 'Cost and credit are recorded per identity.',
    detail: "Every action is a signed event that anyone can verify, including a third party's own agent. Cost and credit are recorded per identity, and .fair turns that into who gets paid.",
  },
];

const actionClass = 'inline-flex min-h-11 items-center justify-center rounded-md px-5 py-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400';
const linkClass = 'text-amber-400 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400';

export default async function Home() {
  const host = domainFromHost((await headers()).get('host'));
  const destination = host ? await domainLanding(host) : null;
  if (destination) redirect(destination);

  return (
    <main className="min-h-screen bg-gray-950 px-6 py-12 text-gray-100 sm:py-16">
      <div className="mx-auto max-w-5xl space-y-10">
        <header className="max-w-3xl space-y-4">
          <p className="text-sm font-medium uppercase tracking-widest text-amber-400">Imajin · Alpha · The trust layer for AI agents</p>
          <h1 className="text-3xl font-bold leading-tight sm:text-5xl">Identity and authority for AI agents.</h1>
          <p className="text-lg leading-relaxed text-gray-300">Your agents act as themselves, on your authority, and every action is signed.</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/alpha?intent=demo" className={`${actionClass} bg-amber-400 text-gray-950 hover:bg-amber-300`}>Book a demo</Link>
            <Link href="/alpha" className={`${actionClass} border border-gray-500 hover:border-amber-400`}>Join the alpha</Link>
          </div>
        </header>

        <section id="product" aria-label="The three pillars" className="grid scroll-mt-6 gap-3 md:grid-cols-3">
          {pillars.map((pillar) => (
            <article key={pillar.title} className="rounded-xl border border-gray-700 bg-gray-900 p-5">
              <h2 className="text-lg font-semibold">{pillar.title}</h2>
              <p className="mt-2 text-sm text-gray-300">{pillar.summary}</p>
              <details className="mt-3 text-sm">
                <summary className="min-h-11 cursor-pointer py-3 text-amber-400">Details · in alpha</summary>
                <p className="mt-2 leading-relaxed text-gray-300">{pillar.detail}</p>
              </details>
            </article>
          ))}
        </section>

        <section aria-labelledby="fit-heading" className="space-y-3">
          <h2 id="fit-heading" className="text-xl font-semibold">How it fits</h2>
          <p className="text-gray-300">A plugin for your agent runtime plus the Imajin kernel.</p>
          <Link href="/how-it-works" className={`inline-block min-h-11 py-3 ${linkClass}`}>How it works →</Link>
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer py-3 text-amber-400">Who it&apos;s for</summary>
            <div className="mt-2 space-y-3 leading-relaxed text-gray-300">
              <p>Businesses putting AI agents in front of customers or staff, where the agent acts for a person: it pays, books, discloses data or signs.</p>
              <p>Platforms and agencies running agents for many clients (multi-principal).</p>
            </div>
          </details>
        </section>

        <section aria-labelledby="proof-heading" className="space-y-3">
          <h2 id="proof-heading" className="text-xl font-semibold">Imajin on Imajin</h2>
          <p className="max-w-3xl leading-relaxed text-gray-300">Our own operations agent works under its own identity every day, with signed events, approvals and cost recorded per identity.</p>
          <p className="text-gray-300">Plus Agentic Travel Co and Agricultural Supply Chain Co, anonymized until agreements are signed.</p>
        </section>

        <footer className="space-y-3 border-t border-gray-700 pt-6">
          <p className="text-sm text-gray-300">Join the alpha as a tester, integrator or partner.</p>
          <p className="text-sm text-gray-300">
            Developers: <Link href="/docs" className={linkClass}>docs</Link> and{' '}
            <a href="https://github.com/ima-jin/imajin-ai/tree/main/packages/auth-client" className={linkClass}>SDK</a>
          </p>
        </footer>
      </div>
    </main>
  );
}
