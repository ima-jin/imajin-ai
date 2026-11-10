import type { Metadata } from 'next';
import { AlphaForm } from './alpha-form';
import { ALPHA_CONFIRMATION, initialAlphaIntent } from '@/src/lib/alpha/contract';

const description = 'Imajin is the trust layer for AI agents. Join the alpha as a tester, integrator or partner, or book a demo.';
export const metadata: Metadata = {
  title: 'Join the alpha',
  description,
  alternates: { canonical: '/alpha' },
  openGraph: { title: 'Join the Imajin alpha', description, url: '/alpha' },
  twitter: { title: 'Join the Imajin alpha', description },
};

export default async function AlphaPage({ searchParams }: Readonly<{
  searchParams: Promise<{ intent?: string | string[]; received?: string }>;
}>) {
  const { intent, received } = await searchParams;
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 sm:py-16">
      <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-orange-600 dark:text-orange-400">Imajin · Alpha</p>
      <h1 className="text-3xl font-semibold sm:text-4xl">Identity and authority for AI agents.</h1>
      <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">
        Join the alpha, or book a demo. Tell us what your agents will do for people.
      </p>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
        This is an alpha, not self-serve sign-up. We&apos;ll reach out to discuss your request.
      </p>
      <details className="my-6 border-y border-gray-200 py-3 dark:border-gray-800">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">Who is Imajin for?</summary>
        <p className="pb-3 text-sm text-gray-600 dark:text-gray-300">
          The trust layer for AI agents — for businesses putting agents in front of customers or staff,
          and platforms and agencies running agents for many clients.
        </p>
      </details>
      {received === '1' ? <div role="status" className="rounded border border-orange-300 p-6">
        <h2 className="text-xl font-semibold">Request received</h2>
        <p className="mt-2">{ALPHA_CONFIRMATION}</p>
      </div> : <AlphaForm key={initialAlphaIntent(intent)} initialIntent={initialAlphaIntent(intent)} />}
    </main>
  );
}
