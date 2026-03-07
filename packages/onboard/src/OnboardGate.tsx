'use client';

import React, { useState, useEffect, useCallback } from 'react';

export interface OnboardGateProps {
  /** Human-readable description: "enroll in this course" */
  action: string;
  /** Called when identity is available (existing session or newly onboarded) */
  onIdentity: (did: string) => void;
  /** The trigger element (e.g., a button) */
  children: React.ReactNode;
  /** Auth service URL */
  authUrl?: string;
  /** URL to redirect back to after email verification */
  redirectUrl?: string;
  /** Skip email verification for low-stakes actions */
  requireVerification?: boolean;
}

type State = 'idle' | 'checking' | 'prompt' | 'sending' | 'sent' | 'error';

export function OnboardGate({
  action,
  onIdentity,
  children,
  authUrl: authUrlProp,
  redirectUrl,
  requireVerification = true,
}: OnboardGateProps) {
  const [state, setState] = useState<State>('idle');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  // Resolve auth URL from props or env
  const authUrl = authUrlProp || (
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.hostname.replace(/^[^.]+/, 'auth')}`
      : ''
  );

  const checkSession = useCallback(async () => {
    setState('checking');
    try {
      const res = await fetch(`${authUrl}/api/session`, { credentials: 'include' });
      if (res.ok) {
        const session = await res.json();
        onIdentity(session.did);
        return;
      }
    } catch {
      // No session — continue to prompt
    }
    setState('prompt');
  }, [authUrl, onIdentity]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    if (!requireVerification) {
      // Direct soft DID creation (no email verification)
      setState('sending');
      try {
        const res = await fetch(`${authUrl}/api/session/soft`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined }),
        });
        if (res.ok) {
          const data = await res.json();
          onIdentity(data.did);
          return;
        }
        setError('Something went wrong. Please try again.');
        setState('prompt');
      } catch {
        setError('Connection error. Please try again.');
        setState('prompt');
      }
      return;
    }

    // Verified flow — send email
    setState('sending');
    setError('');
    try {
      const res = await fetch(`${authUrl}/api/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          redirectUrl: redirectUrl || window.location.href,
          context: action,
        }),
      });

      if (res.ok) {
        setState('sent');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to send verification email');
        setState('prompt');
      }
    } catch {
      setError('Connection error. Please try again.');
      setState('prompt');
    }
  }

  function handleTriggerClick() {
    checkSession();
  }

  // Idle state — show the trigger
  if (state === 'idle') {
    return (
      <div onClick={handleTriggerClick} style={{ cursor: 'pointer' }}>
        {children}
      </div>
    );
  }

  // Checking session
  if (state === 'checking') {
    return (
      <div className="text-center py-4 text-gray-500">
        Checking...
      </div>
    );
  }

  // Email sent — waiting for verification
  if (state === 'sent') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 text-center max-w-md mx-auto">
        <div className="text-4xl mb-4">📬</div>
        <h3 className="font-semibold text-lg mb-2">Check your email</h3>
        <p className="text-gray-500 text-sm mb-4">
          We sent a verification link to <strong className="text-gray-700 dark:text-gray-300">{email}</strong>.
          Click the link to {action}.
        </p>
        <p className="text-xs text-gray-400">
          Link expires in 15 minutes. Check spam if you don't see it.
        </p>
        <button
          onClick={() => setState('prompt')}
          className="mt-4 text-sm text-amber-500 hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  // Prompt for email
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-md mx-auto">
      <h3 className="font-semibold text-lg mb-2">
        Enter your email to {action}
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        We'll send a verification link. No password needed.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoFocus
          className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name (optional)"
          className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
        />
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
        <button
          type="submit"
          disabled={state === 'sending' || !email.trim()}
          className="w-full px-4 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending...' : 'Continue'}
        </button>
      </form>

      <button
        onClick={() => setState('idle')}
        className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600"
      >
        Cancel
      </button>
    </div>
  );
}
