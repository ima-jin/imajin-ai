'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ALPHA_CHOICES, ALPHA_CONFIRMATION, ALPHA_LIMITS, type AlphaIntent } from '@/src/lib/alpha/contract';

const INPUT_CLASS = 'mt-1 min-h-11 w-full rounded border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-600';
const UNAVAILABLE = 'Could not save your request. Please try again later.';

export function AlphaForm({ initialIntent }: Readonly<{ initialIntent: AlphaIntent }>) {
  const [intent, setIntent] = useState<AlphaIntent>(initialIntent);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus('sending');
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/alpha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      if (!response.ok) {
        setError(response.status === 429 ? 'Too many requests. Please try again later.' : UNAVAILABLE);
        setStatus('idle');
        return;
      }
      setStatus('sent');
    } catch {
      setError(UNAVAILABLE);
      setStatus('idle');
    } finally {
      inFlight.current = false;
    }
  }

  if (status === 'sent') return <div role="status" className="rounded border border-orange-300 p-6">
    <h2 className="text-xl font-semibold">Request received</h2>
    <p className="mt-2">{ALPHA_CONFIRMATION}</p>
  </div>;

  return (
    <form onSubmit={submit} className="space-y-5">
      <label className="block text-sm font-medium" htmlFor="alpha-name">Name
        <input className={INPUT_CLASS} id="alpha-name" name="name" autoComplete="name" maxLength={ALPHA_LIMITS.name} required />
      </label>
      <label className="block text-sm font-medium" htmlFor="alpha-email">Work email
        <input className={INPUT_CLASS} id="alpha-email" name="email" type="email" autoComplete="email" maxLength={ALPHA_LIMITS.email} required />
      </label>
      <label className="block text-sm font-medium" htmlFor="alpha-company">Company
        <input className={INPUT_CLASS} id="alpha-company" name="company" autoComplete="organization" maxLength={ALPHA_LIMITS.company} required />
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">What would you like to do?</legend>
        {ALPHA_CHOICES.map(choice => <label key={choice.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded border border-gray-200 p-3 dark:border-gray-700">
          <input type="radio" className="mt-1 accent-orange-600" name="intent" value={choice.value}
            checked={intent === choice.value} onChange={() => setIntent(choice.value)} required />
          <span><span className="block text-sm font-semibold">{choice.label}</span>
            <span className="text-sm text-gray-600 dark:text-gray-400">{choice.description}</span></span>
        </label>)}
      </fieldset>
      <label className="block text-sm font-medium" htmlFor="alpha-purpose">What will your agents do for people?
        <textarea id="alpha-purpose" name="purpose" className={INPUT_CLASS} rows={3} maxLength={ALPHA_LIMITS.purpose}
          aria-describedby="alpha-purpose-help" required />
      </label>
      <p id="alpha-purpose-help" className="text-xs text-gray-500">Up to 1000 characters. Please don&apos;t include secrets or sensitive customer data.</p>
      <div className="hidden" aria-hidden="true">
        <label htmlFor="alpha-website">Leave this empty</label>
        <input id="alpha-website" name="website" autoComplete="off" tabIndex={-1} />
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">We&apos;ll use these details to respond to your request. They are not posted publicly.</p>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={status === 'sending'}
        className="min-h-11 rounded bg-orange-600 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50">
        {status === 'sending' ? 'Sending…' : 'Send request'}
      </button>
    </form>
  );
}
