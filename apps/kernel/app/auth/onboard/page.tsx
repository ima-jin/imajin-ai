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

type Flow = 'choose' | 'email' | 'email-sent' | 'keypair-confirm' | 'keypair-loading';

function OnboardContent() {
  const params = useSearchParams();
  const scope = params.get('scope') || '';
  const redirect = params.get('redirect') || params.get('redirectUrl') || '';

  const [flow, setFlow] = useState<Flow>('choose');
  const [scopeProfile, setScopeProfile] = useState<ScopeProfile | null>(null);
  const [scopeLoading, setScopeLoading] = useState(!!scope);

  // Email flow
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  // Keypair flow
  const [keypair, setKeypair] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [keypairAck, setKeypairAck] = useState(false);
  const [keypairError, setKeypairError] = useState('');

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

  // ── Render ──────────────────────────────────────────────────────────────

  const loginUrl = `/login${redirect || scope ? `?next=${encodeURIComponent(redirect || '/')}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}` : ''}`;

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">

        {/* Scope header */}
        <div className="text-center space-y-3">
          {scopeLoading ? (
            <div className="w-16 h-16 rounded-full bg-gray-800 mx-auto animate-pulse" />
          ) : scopeProfile?.avatarUrl ? (
            <img src={scopeProfile.avatarUrl} alt="" className="w-16 h-16 rounded-full mx-auto object-cover border border-gray-700" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-gray-800 mx-auto flex items-center justify-center text-2xl">
              {scopeProfile?.scope === 'business' ? '🏢' : scopeProfile?.scope === 'family' ? '👨‍👩‍👦' : '🏛️'}
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold text-white">
              {scopeName ? `Join ${scopeName}` : 'Get started'}
            </h1>
            {scopeProfile?.scope && (
              <span className="inline-block mt-1 px-2 py-0.5 text-xs rounded-full border border-gray-700 text-gray-400 capitalize">
                {scopeProfile.scope}
              </span>
            )}
          </div>
        </div>

        {/* Flows */}
        {flow === 'choose' && (
          <div className="space-y-3">
            <button
              onClick={() => setFlow('email')}
              className="w-full flex items-center gap-3 px-4 py-3 bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl text-white transition text-left"
            >
              <span className="text-lg">📧</span>
              <span className="font-medium">Continue with email</span>
            </button>
            <button
              onClick={handleGenerateKeypair}
              className="w-full flex items-center gap-3 px-4 py-3 bg-amber-500 hover:bg-amber-400 rounded-xl text-gray-950 transition text-left font-semibold"
            >
              <span className="text-lg">🔑</span>
              <span>Create identity</span>
            </button>
            <a
              href={loginUrl}
              className="w-full flex items-center justify-center px-4 py-3 bg-transparent border border-gray-800 hover:border-gray-600 rounded-xl text-gray-400 hover:text-gray-200 transition text-sm no-underline"
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
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 focus:border-amber-500 rounded-xl text-white placeholder-gray-600 outline-none transition"
            />
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 focus:border-amber-500 rounded-xl text-white placeholder-gray-600 outline-none transition"
            />
            {emailError && <p className="text-red-400 text-sm">{emailError}</p>}
            <button
              type="submit"
              disabled={emailLoading}
              className="w-full py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-xl text-gray-950 font-semibold transition"
            >
              {emailLoading ? 'Sending…' : 'Send verification email'}
            </button>
            <button
              type="button"
              onClick={() => setFlow('choose')}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-300 transition"
            >
              ← Back
            </button>
          </form>
        )}

        {flow === 'email-sent' && (
          <div className="text-center space-y-4 bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <div className="text-4xl">📬</div>
            <h2 className="text-white font-semibold">Check your email</h2>
            <p className="text-gray-400 text-sm">
              We sent a verification link to <strong className="text-white">{email}</strong>.
              Click it to continue.
            </p>
            <p className="text-gray-600 text-xs">Link expires in 15 minutes.</p>
          </div>
        )}

        {flow === 'keypair-confirm' && keypair && (
          <div className="space-y-4">
            <div className="bg-gray-900 border border-amber-600/40 rounded-2xl p-5 space-y-4">
              <div className="flex items-start gap-3">
                <span className="text-xl mt-0.5">⚠️</span>
                <div>
                  <p className="text-white font-semibold text-sm">Save your recovery key</p>
                  <p className="text-gray-400 text-sm mt-1">
                    This is your only way to recover your identity. If you lose it, your account cannot be recovered.
                  </p>
                </div>
              </div>
              <button
                onClick={downloadKeypair}
                className="w-full flex items-center justify-center gap-2 py-2.5 border border-gray-700 hover:border-amber-500 rounded-xl text-gray-300 hover:text-amber-400 transition text-sm"
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
                <span className="text-gray-400 text-sm">I have saved my recovery key and understand it cannot be recovered if lost.</span>
              </label>
            </div>
            {keypairError && <p className="text-red-400 text-sm">{keypairError}</p>}
            <button
              onClick={handleKeypairContinue}
              disabled={!keypairAck}
              className="w-full py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 rounded-xl text-gray-950 font-semibold transition"
            >
              Continue →
            </button>
            <button
              type="button"
              onClick={() => setFlow('choose')}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-300 transition"
            >
              ← Back
            </button>
          </div>
        )}

        {flow === 'keypair-loading' && (
          <div className="text-center space-y-3 py-6">
            <div className="text-3xl animate-pulse">🔑</div>
            <p className="text-gray-400 text-sm">Creating your identity…</p>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-gray-600">Powered by Imajin</p>
      </div>
    </div>
  );
}

export default function OnboardPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-gray-600 text-sm">Loading…</div>
      </div>
    }>
      <OnboardContent />
    </Suspense>
  );
}
