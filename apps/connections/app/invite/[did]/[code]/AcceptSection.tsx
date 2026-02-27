'use client';

import { useState, useEffect } from 'react';

interface Props {
  loginUrl: string;
  code: string;
  connectionsUrl: string;
}

interface Session {
  did: string;
  handle?: string;
}

export function AcceptSection({ loginUrl, code, connectionsUrl }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch('/api/auth/session', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.did) setSession(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleAccept() {
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${code}/accept`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to accept invite');
        return;
      }
      setDone(true);
    } catch {
      setError('Network error — please try again');
    } finally {
      setAccepting(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-3">
        <div className="text-4xl mb-3">🤝</div>
        <p className="text-green-400 font-semibold text-lg">Connected!</p>
        <a
          href={connectionsUrl}
          className="inline-block px-6 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          View Your Connections
        </a>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-4 text-gray-500 text-sm">Checking session…</div>
    );
  }

  if (session) {
    return (
      <div className="space-y-3">
        <p className="text-gray-400 text-sm">
          Signed in as <span className="text-white font-medium">{session.handle ? `@${session.handle}` : session.did.slice(0, 20) + '...'}</span>
        </p>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          onClick={handleAccept}
          disabled={accepting}
          className="w-full px-6 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-500/50 text-black font-semibold rounded-lg transition"
        >
          {accepting ? 'Accepting…' : 'Accept Invite'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <a
        href={loginUrl}
        className="block w-full px-6 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition text-center"
      >
        Login &amp; Accept Invite
      </a>
      <p className="text-gray-500 text-xs">
        You&apos;ll be redirected to sign in, then brought back to accept.
      </p>
    </div>
  );
}
