import type { Metadata } from 'next';
import Link from 'next/link';
import { ImajinFooter } from '@imajin/ui';

const title = 'Why we built it this way';
const description = 'Why Imajin is built around agent identity, signatures and a record you own. State of Imajin, November 2026: our hardware, what works and the limits of this alpha.';

export const metadata: Metadata = {
  title,
  description,
  keywords: ['Imajin', 'AI agents', 'agent identity', 'signed record', 'alpha'],
  alternates: { canonical: '/project' },
  openGraph: {
    title,
    description,
    url: '/project',
    type: 'website',
    images: [],
  },
  twitter: { card: 'summary', title, description, images: [] },
};

const disclosureClass = 'rounded-lg border border-gray-800 p-5';
const summaryClass = 'cursor-pointer text-lg font-semibold text-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400';
const listClass = 'mt-4 list-disc space-y-3 pl-5 text-gray-300 leading-relaxed';

export default function ProjectPage() {
  return (
    <main className="min-h-screen bg-gray-950 px-6 py-12 text-gray-100">
      <article className="mx-auto max-w-3xl">
        <header className="mb-8">
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-amber-400">
            Imajin · Alpha
          </p>
          <h1 className="mb-4 text-3xl font-bold tracking-tight md:text-5xl">{title}</h1>
          <p className="text-lg leading-relaxed text-gray-300">
            An agent should carry its own identity. Trust should live in signatures, not a vendor.
            You should be able to own the record and run it on hardware you own.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-gray-400">
            Imajin is the trust layer for AI agents. This is why we built it this way, not a promise
            that the alpha is finished. The dated details and limits are below.
          </p>
          <Link href="/whitepaper" className="mt-4 inline-block text-amber-400 underline underline-offset-4 hover:text-amber-300">
            Read the whitepaper for the reasoning
          </Link>
        </header>

        <div className="space-y-3">
          <details className={disclosureClass}>
            <summary className={summaryClass}>
              State of Imajin, November 2026
              <span className="mt-1 block text-sm font-normal text-gray-400">
                Our own hardware; frontier judgment, local model work.
              </span>
            </summary>
            <div className="mt-4 text-gray-300 leading-relaxed">
              <p>We run on our own hardware:</p>
              <ul className={listClass}>
                <li>One GPU box with an RTX 5090 for local models.</li>
                <li>One Grace Blackwell workstation with 128 GB unified memory for a 120B model plus embeddings and retrieval.</li>
                <li>One platform server.</li>
              </ul>
              <p className="mt-4">
                Frontier models do judgment work. Local models do coding, research, embeddings
                and transcription.
              </p>
              <p className="mt-3">
                This is how we operate today, not hardware you need to buy to use Imajin.
              </p>
            </div>
          </details>

          <details className={disclosureClass}>
            <summary className={summaryClass}>
              What Imajin adds to an agent harness
              <span className="mt-1 block text-sm font-normal text-gray-400">
                Identity, a signed record, human approval and cost per identity.
              </span>
            </summary>
            <p className="mt-4 leading-relaxed text-gray-300">
              The harness runs the agent. Imajin adds identity and authority for AI agents;
              you use both. Our own operations agent uses this today.
            </p>
            <ul className={listClass}>
              <li>Its own identity per agent: the agent acts as itself, not as the person.</li>
              <li>A signed record of what the agent did and on whose authority.</li>
              <li>Approval by a person: risky actions wait for a named human approver.</li>
              <li>Several identities on one runtime, each for its own principal.</li>
              <li>Events pushed to the agent.</li>
              <li>Cost and credit recorded per identity (.fair).</li>
            </ul>
          </details>

          <details className={disclosureClass}>
            <summary className={summaryClass}>
              Honest limits
              <span className="mt-1 block text-sm font-normal text-gray-400">
                Early plugin, people in the loop, one server and few outside users.
              </span>
            </summary>
            <ul className={listClass}>
              <li>The plugin is early (v0.1).</li>
              <li>We depend on upstream for some harness paths.</li>
              <li>Frontier models still do the judgment work.</li>
              <li>A person is still in the dispatch loop.</li>
              <li>One server, no redundancy yet.</li>
              <li>Few outside users so far.</li>
            </ul>
          </details>
        </div>

        <section aria-labelledby="try-it" className="mt-8 border-t border-gray-800 pt-6">
          <h2 id="try-it" className="text-xl font-semibold">
            Don&apos;t trust us; point your agent at it
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-300">
            This is an alpha. Book a demo, or join the alpha as a tester, integrator or partner.
            Joining the alpha is the sign-up path for now.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link href="/alpha?intent=demo" className="rounded-md bg-amber-500 px-5 py-3 text-center font-semibold text-gray-950 hover:bg-amber-400">
              Book a demo
            </Link>
            <Link href="/alpha" className="rounded-md border border-gray-600 px-5 py-3 text-center font-semibold text-gray-100 hover:border-amber-400">
              Join the alpha
            </Link>
          </div>
        </section>
      </article>
      <footer className="mx-auto mt-12 max-w-3xl">
        <ImajinFooter />
      </footer>
    </main>
  );
}
