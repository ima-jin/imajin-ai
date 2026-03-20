'use client';

import { useState } from 'react';

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';

export function MagicLinkButton({ eventId }: { eventId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error' | 'hard-did'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) return;

    setStatus('sending');
    try {
      const eventsUrl = window.location.origin;
      const response = await fetch(`${AUTH_URL}/api/magic/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          redirectUrl: `${eventsUrl}/${eventId}`,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 403) {
          setErrorMessage(data.error || 'This account requires private key authentication.');
          setStatus('hard-did');
          return;
        }
        throw new Error('Failed');
      }
      setStatus('sent');
    } catch {
      setStatus('error');
    }
  };

  if (status === 'hard-did') {
    return (
      <p className="text-sm text-amber-400">
        🔐 {errorMessage}
      </p>
    );
  }

  if (status === 'sent') {
    return (
      <p className="text-sm text-green-500">
        ✓ Check your email for a login link
      </p>
    );
  }

  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="text-sm text-orange-500 hover:text-orange-400 transition"
      >
        Already have a ticket?
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        type="email"
        placeholder="your@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
        className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 w-48"
      />
      <button
        type="submit"
        disabled={status === 'sending' || !email.includes('@')}
        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600 transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {status === 'sending' ? 'Sending…' : 'Send link'}
      </button>
      <button
        type="button"
        onClick={() => { setShowForm(false); setStatus('idle'); }}
        className="text-sm text-gray-400 hover:text-gray-300"
      >
        ✕
      </button>
      {status === 'error' && (
        <span className="text-xs text-red-500">Failed — try again</span>
      )}
    </form>
  );
}
