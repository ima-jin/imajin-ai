'use client';

import { useEffect, useRef, useState } from 'react';
import { buildPublicUrl } from '@imajin/config';

const AUTH_URL = buildPublicUrl('auth');
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // matches onboard token TTL

type Status =
  | 'idle'
  | 'sending'
  | 'sent-polling'
  | 'completed'
  | 'expired'
  | 'error'
  | 'hard-did';

export function MagicLinkButton({ eventId }: Readonly<{ eventId: string }>) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [pollHandle, setPollHandle] = useState<string | null>(null);
  const pollStartedAt = useRef<number | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) return;

    setStatus('sending');
    setErrorMessage('');
    try {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const eventsUrl = globalThis.location.origin;
      const response = await fetch(`${AUTH_URL}/api/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          mode: 'login',
          wantPolling: true,
          context: 'log back in',
          redirectUrl: `${eventsUrl}${basePath}/${eventId}`,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 403) {
          setErrorMessage(data.error || 'This account requires private key authentication.');
          setStatus('hard-did');
          return;
        }
        if (response.status === 429) {
          setErrorMessage(data.error || 'Too many requests — please wait a moment.');
          setStatus('error');
          return;
        }
        throw new Error('Failed');
      }

      const data = await response.json();
      setPollHandle(data.pollHandle ?? null);
      pollStartedAt.current = Date.now();
      setStatus('sent-polling');
    } catch {
      setStatus('error');
      setErrorMessage('Could not send login link — please try again.');
    }
  };

  // Cross-tab handoff: poll for verification, then claim the session in this tab.
  // When the user clicks the email link in another tab, /api/onboard/verify marks
  // the token used and produces a handoffToken; we exchange it for a real session
  // cookie here so the user lands back in the original tab already logged in.
  useEffect(() => {
    if (status !== 'sent-polling' || !pollHandle) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      // Stop polling after the token TTL.
      if (pollStartedAt.current && Date.now() - pollStartedAt.current > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        if (!cancelled) {
          setStatus('expired');
          setErrorMessage('Login link expired. Send a new one.');
        }
        return;
      }

      try {
        const res = await fetch(
          `${AUTH_URL}/api/onboard/poll?handle=${encodeURIComponent(pollHandle)}`,
        );
        if (!res.ok) {
          // 429 etc. — keep polling; one bad poll isn't fatal.
          return;
        }
        const data = await res.json();
        if (cancelled) return;

        if (data.status === 'completed' && data.handoffToken) {
          clearInterval(interval);
          const claimRes = await fetch(`${AUTH_URL}/api/onboard/claim`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handoffToken: data.handoffToken }),
          });
          if (!claimRes.ok) {
            const errData = await claimRes.json().catch(() => ({}));
            if (claimRes.status === 410) {
              setStatus('expired');
              setErrorMessage('Login link expired. Send a new one.');
            } else {
              setStatus('error');
              setErrorMessage(errData.error || 'Could not complete login.');
            }
            return;
          }
          globalThis.dispatchEvent(new Event('imajin:session-changed'));
          setStatus('completed');
          // Reload the event page so server components pick up the new session.
          // Give the cookie a beat to settle before navigating.
          setTimeout(() => globalThis.location.reload(), 800);
        } else if (data.status === 'expired') {
          clearInterval(interval);
          setStatus('expired');
          setErrorMessage('Login link expired. Send a new one.');
        }
      } catch {
        // Network blip — keep polling.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, pollHandle]);

  if (status === 'hard-did') {
    return (
      <p className="text-sm text-amber-400">
        🔐 {errorMessage}
      </p>
    );
  }

  if (status === 'completed') {
    return (
      <p className="text-sm text-green-500">
        ✓ Logged in. Loading…
      </p>
    );
  }

  if (status === 'sent-polling') {
    return (
      <p className="text-sm text-green-500">
        ✓ Check your email — once you click the link, you can close that tab and come back here.
      </p>
    );
  }

  if (status === 'expired') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-red-400">{errorMessage}</span>
        <button
          onClick={() => {
            setStatus('idle');
            setPollHandle(null);
            setErrorMessage('');
          }}
          className="text-sm text-orange-500 hover:text-orange-400"
        >
          Try again
        </button>
      </div>
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
        onClick={() => { setShowForm(false); setStatus('idle'); setErrorMessage(''); }}
        className="text-sm text-gray-400 hover:text-gray-300"
      >
        ✕
      </button>
      {status === 'error' && (
        <span className="text-xs text-red-500">{errorMessage || 'Failed — try again'}</span>
      )}
    </form>
  );
}
