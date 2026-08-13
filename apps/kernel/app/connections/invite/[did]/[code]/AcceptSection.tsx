'use client';

import { useState, useEffect } from 'react';

interface Props {
  loginUrl: string;
  code: string;
  connectionsUrl: string;
  /**
   * Onboarding URL for this invite's scopeDid context (#1834 Phase 2), or
   * null when the invite carries no context. When present, this becomes
   * the primary CTA for both the not-yet-authenticated visitor (so
   * accepting a scoped invite lands them in onboarding instead of the
   * generic register flow) and the just-accepted authenticated acceptor
   * (so they can complete the scope join / claim afterward).
   */
  onboardUrl: string | null;
}

interface Session {
  did: string;
  handle?: string;
}

export function AcceptSection({ loginUrl, code, connectionsUrl, onboardUrl }: Readonly<Props>) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch('/auth/api/session', { credentials: 'include' })
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
      const res = await fetch(`/connections/api/invites/${code}/accept`, {
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

  // Unauthenticated + scoped invite (#1834 Phase 2): the click-alone accept
  // (invite-accept route, #1834 Phase 1) forms the connection AS the
  // pre-minted claimable stub — this IS the inviter-side countersign — then
  // hands off to onboarding to complete the claimant-side email
  // verification. Best-effort: if accept fails (e.g. this email already
  // belongs to a real account), onboarding still lets them continue via
  // login instead.
  async function handleContinueToOnboarding() {
    if (!onboardUrl) return;
    setAccepting(true);
    try {
      await fetch(`/connections/api/invites/${code}/accept`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // best-effort — onboarding/login remains available either way
    } finally {
      globalThis.location.href = onboardUrl;
    }
  }

  if (done) {
    return (
      <div className="space-y-3">
        <div className="text-4xl mb-3">🤝</div>
        <p className="text-green-400 font-semibold text-lg">Connected!</p>
        {onboardUrl ? (
          <a
            href={onboardUrl}
            className="inline-block px-6 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
          >
            Continue
          </a>
        ) : (
          <a
            href={connectionsUrl}
            className="inline-block px-6 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
          >
            View Your Connections
          </a>
        )}
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
        <button type="button"
          onClick={handleAccept}
          disabled={accepting}
          className="w-full px-6 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-500/50 text-black font-semibold rounded-lg transition"
        >
          {accepting ? 'Accepting…' : 'Accept Invite'}
        </button>
      </div>
    );
  }

  if (onboardUrl) {
    return (
      <div className="space-y-3">
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="button"
          onClick={handleContinueToOnboarding}
          disabled={accepting}
          className="block w-full px-6 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-500/50 text-black font-semibold rounded-lg transition text-center"
        >
          {accepting ? 'Continuing…' : 'Continue'}
        </button>
        <a
          href={loginUrl}
          className="block w-full px-6 py-3 bg-white/10 hover:bg-white/15 text-white font-medium rounded-lg transition text-center"
        >
          Already have an account? Login
        </a>
      </div>
    );
  }

  const registerUrl = loginUrl.replaceAll('/login?', `/register?invite=${code}&`);

  return (
    <div className="space-y-3">
      <a
        href={registerUrl}
        className="block w-full px-6 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition text-center"
      >
        Create Account &amp; Connect
      </a>
      <a
        href={loginUrl}
        className="block w-full px-6 py-3 bg-white/10 hover:bg-white/15 text-white font-medium rounded-lg transition text-center"
      >
        Already have an account? Login
      </a>
      <p className="text-gray-500 text-xs">
        Imajin is invite-only. This invite is your gateway in.
      </p>
    </div>
  );
}
