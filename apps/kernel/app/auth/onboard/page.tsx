'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { buildPublicUrl } from '@imajin/config';
import * as ed from '@noble/ed25519';

// Bytes → hex
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

interface ScopeProfile {
  name?: string;
  handle?: string;
  avatarUrl?: string;
  scope?: string;
}

interface SessionInfo {
  did: string;
  handle?: string;
  name?: string;
}

type Flow = 'choose' | 'email' | 'email-sent' | 'keypair-confirm' | 'keypair-loading' | 'join' | 'join-loading' | 'join-done';

function OnboardContent() {
  const params = useSearchParams();
  const scope = params.get('scope') || '';
  const redirect = params.get('redirect') || params.get('redirectUrl') || '';

  const [flow, setFlow] = useState<Flow>('choose');
  const [scopeProfile, setScopeProfile] = useState<ScopeProfile | null>(null);
  const [scopeLoading, setScopeLoading] = useState(!!scope);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Email flow
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  // Keypair flow
  const [keypair, setKeypair] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [keypairAck, setKeypairAck] = useState(false);
  const [keypairError, setKeypairError] = useState('');

  // Join flow
  const [joinError, setJoinError] = useState('');

  // Check session
  useEffect(() => {
    fetch('/auth/api/session', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.did) {
          setSessionInfo({ did: data.did, handle: data.handle, name: data.name });
          if (scope) setFlow('join');
        }
      })
      .catch(() => {})
      .finally(() => setSessionChecked(true));
  }, [scope]);

  useEffect(() => {
    if (!scope) return;
    const profileUrl = buildPublicUrl('profile');
    fetch(`${profileUrl}/api/profile/${encodeURIComponent(scope)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setScopeProfile(data);
      })
      .catch(() => {})
      .finally(() => setScopeLoading(false));
  }, [scope]);

  const scopeName = scopeProfile?.name || scopeProfile?.handle || (scope ? scope.slice(0, 20) : null);

  // ── Email flow ──────────────────────────────────────────────────────────

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError('');
    if (!email.includes('@')) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailLoading(true);
    try {
      const res = await fetch('/auth/api/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name: name.trim() || undefined,
          scopeDid: scope || undefined,
          redirectUrl: redirect || undefined,
          context: scopeName ? `Join ${scopeName}` : undefined,
        }),
      });
      if (res.ok) {
        setFlow('email-sent');
      } else {
        const body = await res.json().catch(() => ({}));
        setEmailError(body.error || 'Something went wrong. Please try again.');
      }
    } catch {
      setEmailError('Network error. Please try again.');
    } finally {
      setEmailLoading(false);
    }
  }

  // ── Keypair flow ────────────────────────────────────────────────────────

  async function handleGenerateKeypair() {
    setFlow('keypair-confirm');
    setKeypairAck(false);
    const privateKeyBytes = ed.utils.randomPrivateKey();
    const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
    setKeypair({
      privateKey: bytesToHex(privateKeyBytes),
      publicKey: bytesToHex(publicKeyBytes),
    });
  }

  function downloadKeypair() {
    if (!keypair) return;
    const data = JSON.stringify({
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      note: 'Keep this file safe. Your private key cannot be recovered if lost.',
      createdAt: new Date().toISOString(),
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'imajin-identity.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleKeypairContinue() {
    if (!keypair || !keypairAck) return;
    setFlow('keypair-loading');
    setKeypairError('');
    try {
      const res = await fetch('/auth/api/onboard/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey,
          name: name.trim() || undefined,
          scopeDid: scope || undefined,
          redirectUrl: redirect || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        window.location.href = data.redirectUrl || redirect || '/';
      } else {
        const body = await res.json().catch(() => ({}));
        setKeypairError(body.error || 'Something went wrong. Please try again.');
        setFlow('keypair-confirm');
      }
    } catch {
      setKeypairError('Network error. Please try again.');
      setFlow('keypair-confirm');
    }
  }

  // ── Join flow (already authenticated) ───────────────────────────────────

  async function handleJoin() {
    setFlow('join-loading');
    setJoinError('');
    try {
      const res = await fetch('/auth/api/onboard/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scopeDid: scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        setJoinError(data.error || 'Failed to join');
        setFlow('join');
        return;
      }
      setFlow('join-done');
    } catch {
      setJoinError('Network error. Please try again.');
      setFlow('join');
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const loginUrl = `/login${redirect || scope ? `?next=${encodeURIComponent(redirect || '/')}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}` : ''}`;

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">

        {/* Scope header */}
        <div className="text-center space-y-3">
          {scopeLoading ? (
            <div className="w-16 h-16 rounded-full bg-surface-elevated mx-auto animate-pulse" />
          ) : scopeProfile?.avatarUrl ? (
            <img src={scopeProfile.avatarUrl} alt="" className="w-16 h-16 rounded-full mx-auto object-cover border border-white/10" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-surface-elevated mx-auto flex items-center justify-center text-2xl">
              {scopeProfile?.scope === 'business' ? '🏢' : scopeProfile?.scope === 'family' ? '👨‍👩‍👦' : '🏛️'}
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold text-primary font-mono">
              {scopeName ? `Join ${scopeName}` : 'Get started'}
            </h1>
            {scopeProfile?.scope && (
              <span className="inline-block mt-1 px-2 py-0.5 text-xs border border-white/10 text-secondary capitalize">
                {scopeProfile.scope}
              </span>
            )}
          </div>
        </div>

        {/* Flows */}
        {!sessionChecked && scope && (
          <div className="text-center py-6">
            <div className="text-muted text-sm">Loading…</div>
          </div>
        )}

        {flow === 'join' && sessionInfo && (
          <div className="space-y-3">
            <div className="bg-surface-surface border border-white/10 p-5 text-center space-y-2">
              <p className="text-sm text-secondary">
                Signed in as <span className="text-primary font-medium">{sessionInfo.name || sessionInfo.handle || sessionInfo.did.slice(0, 20)}</span>
              </p>
            </div>
            {joinError && <p className="text-error text-sm text-center">{joinError}</p>}
            <button
              onClick={handleJoin}
              className="w-full py-3 bg-warning hover:bg-warning text-gray-950 font-semibold transition"
            >
              Join {scopeName || 'this group'}
            </button>
            <button
              onClick={() => setFlow('choose')}
              className="w-full py-2 text-sm text-secondary hover:text-primary transition"
            >
              Use a different account
            </button>
          </div>
        )}

        {flow === 'join-loading' && (
          <div className="text-center space-y-3 py-6">
            <div className="text-3xl animate-pulse">🤝</div>
            <p className="text-secondary text-sm">Joining…</p>
          </div>
        )}

        {flow === 'join-done' && (
          <div className="text-center space-y-4 bg-surface-surface border border-white/10 p-6">
            <div className="text-4xl">✅</div>
            <h2 className="text-primary font-semibold font-mono">You&apos;re in!</h2>
            <p className="text-secondary text-sm">
              You&apos;ve joined {scopeName || 'this group'}.
            </p>
            <a
              href={redirect || '/'}
              className="inline-block px-6 py-2.5 bg-warning hover:bg-warning text-gray-950 font-semibold transition no-underline"
            >
              Continue
            </a>
          </div>
        )}

        {flow === 'choose' && sessionChecked && (
          <div className="space-y-3">
            <button
              onClick={() => setFlow('email')}
              className="w-full flex items-center gap-3 px-4 py-3 bg-surface-surface hover:bg-surface-elevated border border-white/10 hover:border-gray-600 text-primary transition text-left"
            >
              <span className="text-lg">📧</span>
              <span className="font-medium">Continue with email</span>
            </button>
            <button
              onClick={handleGenerateKeypair}
              className="w-full flex items-center gap-3 px-4 py-3 bg-warning hover:bg-warning text-gray-950 transition text-left font-semibold"
            >
              <span className="text-lg">🔑</span>
              <span>Create identity</span>
            </button>
            <a
              href={loginUrl}
              className="w-full flex items-center justify-center px-4 py-3 bg-transparent border border-white/10 hover:border-gray-600 text-secondary hover:text-primary transition text-sm no-underline"
            >
              Already have an account? Log in
            </a>
          </div>
        )}

        {flow === 'email' && (
          <form onSubmit={handleEmailSubmit} className="space-y-3">
            <input
              type="text"
              placeholder="Your name (optional)"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-4 py-3 bg-surface-surface border border-white/10 focus:border-imajin-purple text-primary placeholder-muted outline-none transition"
            />
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-4 py-3 bg-surface-surface border border-white/10 focus:border-imajin-purple text-primary placeholder-muted outline-none transition"
            />
            {emailError && <p className="text-error text-sm">{emailError}</p>}
            <button
              type="submit"
              disabled={emailLoading}
              className="w-full py-3 bg-warning hover:bg-warning disabled:opacity-50 text-gray-950 font-semibold transition"
            >
              {emailLoading ? 'Sending…' : 'Send verification email'}
            </button>
            <button
              type="button"
              onClick={() => setFlow('choose')}
              className="w-full py-2 text-sm text-secondary hover:text-primary transition"
            >
              ← Back
            </button>
          </form>
        )}

        {flow === 'email-sent' && (
          <div className="text-center space-y-4 bg-surface-surface border border-white/10 p-6">
            <div className="text-4xl">📬</div>
            <h2 className="text-primary font-semibold font-mono">Check your email</h2>
            <p className="text-secondary text-sm">
              We sent a verification link to <strong className="text-primary">{email}</strong>.
              Click it to continue.
            </p>
            <p className="text-muted text-xs">Link expires in 15 minutes.</p>
          </div>
        )}

        {flow === 'keypair-confirm' && keypair && (
          <div className="space-y-4">
            <div className="bg-surface-surface border border-amber-600/40 p-5 space-y-4">
              <div className="flex items-start gap-3">
                <span className="text-xl mt-0.5">⚠️</span>
                <div>
                  <p className="text-primary font-semibold text-sm">Save your recovery key</p>
                  <p className="text-secondary text-sm mt-1">
                    This is your only way to recover your identity. If you lose it, your account cannot be recovered.
                  </p>
                </div>
              </div>
              <button
                onClick={downloadKeypair}
                className="w-full flex items-center justify-center gap-2 py-2.5 border border-white/10 hover:border-amber-500 text-primary hover:text-warning transition text-sm"
              >
                ⬇ Download imajin-identity.json
              </button>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={keypairAck}
                  onChange={e => setKeypairAck(e.target.checked)}
                  className="mt-1 accent-amber-500"
                />
                <span className="text-secondary text-sm">I have saved my recovery key and understand it cannot be recovered if lost.</span>
              </label>
            </div>
            {keypairError && <p className="text-error text-sm">{keypairError}</p>}
            <button
              onClick={handleKeypairContinue}
              disabled={!keypairAck}
              className="w-full py-3 bg-warning hover:bg-warning disabled:opacity-40 text-gray-950 font-semibold transition"
            >
              Continue →
            </button>
            <button
              type="button"
              onClick={() => setFlow('choose')}
              className="w-full py-2 text-sm text-secondary hover:text-primary transition"
            >
              ← Back
            </button>
          </div>
        )}

        {flow === 'keypair-loading' && (
          <div className="text-center space-y-3 py-6">
            <div className="text-3xl animate-pulse">🔑</div>
            <p className="text-secondary text-sm">Creating your identity…</p>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-muted">Powered by Imajin</p>
      </div>
    </div>
  );
}

export default function OnboardPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-muted text-sm">Loading…</div>
      </div>
    }>
      <OnboardContent />
    </Suspense>
  );
}
