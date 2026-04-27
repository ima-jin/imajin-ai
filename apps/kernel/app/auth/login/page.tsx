'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import KeyAuthTab from './components/KeyAuthTab';
import PasswordAuthTab from './components/PasswordAuthTab';
import MfaGate from './components/MfaGate';

const WWW_URL = process.env.NEXT_PUBLIC_WWW_URL || 'https://imajin.ai';

function NewsletterSignup() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('loading');
    try {
      const res = await fetch(`${WWW_URL}/api/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'login-page' }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('success');
        setMessage(data.message || "You're on the list!");
      } else {
        setStatus('error');
        setMessage(data.error || 'Something went wrong');
      }
    } catch {
      setStatus('error');
      setMessage('Could not connect. Try again later.');
    }
  }

  if (status === 'success') {
    return <p className="text-sm text-[#F59E0B] mt-3">{message}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="Email for updates"
        required
        className="flex-1 px-3 py-1.5 text-sm border border-white/10 bg-surface-base text-primary focus:ring-1 focus:ring-[#F59E0B] focus:border-transparent"
      />
      <button
        type="submit"
        disabled={status === 'loading'}
        className="px-3 py-1.5 text-sm bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-medium disabled:opacity-50"
      >
        {status === 'loading' ? '...' : 'Subscribe'}
      </button>
      {status === 'error' && <p className="text-xs text-error mt-1">{message}</p>}
    </form>
  );
}

type Tab = 'key' | 'password';

interface MfaState {
  methods: string[];
  challengeToken: string;
  did: string;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get('next');
  const [activeTab, setActiveTab] = useState<Tab>('key');
  const [mfaState, setMfaState] = useState<MfaState | null>(null);

  useEffect(() => {
    // If localStorage says logged in, verify the session is still valid
    const storedDid = localStorage.getItem('imajin_did');
    if (storedDid) {
      fetch('/auth/api/session', { credentials: 'include' })
        .then(res => {
          if (res.ok) {
            window.location.href = nextUrl || '/';
          } else {
            localStorage.removeItem('imajin_did');
            localStorage.removeItem('imajin_keypair');
          }
        })
        .catch(() => {});
    }
  }, [nextUrl]);

  function handleSuccess(_did: string) {
    window.location.href = nextUrl || '/';
  }

  function handleMfaRequired(data: MfaState) {
    setMfaState(data);
  }

  if (mfaState) {
    return (
      <MfaGate
        {...mfaState}
        nextUrl={nextUrl}
        onSuccess={handleSuccess}
        onCancel={() => setMfaState(null)}
      />
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-white/10 p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-primary font-mono">Sign in</h1>
        <p className="text-secondary text-center mb-6">Your key is your identity</p>

        {/* Tab selector */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('key')}
            className={`flex-1 px-4 py-2 transition ${activeTab === 'key' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-surface-surface text-secondary hover:bg-surface-elevated'}`}
          >
            Import / Paste Key
          </button>
          <button
            onClick={() => setActiveTab('password')}
            className={`flex-1 px-4 py-2 transition ${activeTab === 'password' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-surface-surface text-secondary hover:bg-surface-elevated'}`}
          >
            Password
          </button>
        </div>

        {activeTab === 'key' && (
          <KeyAuthTab
            nextUrl={nextUrl}
            onMfaRequired={handleMfaRequired}
            onSuccess={handleSuccess}
          />
        )}
        {activeTab === 'password' && (
          <PasswordAuthTab
            nextUrl={nextUrl}
            onMfaRequired={handleMfaRequired}
            onSuccess={handleSuccess}
          />
        )}

        {/* Onboarding info + newsletter */}
        <div className="mt-6 p-4 bg-surface-surface border border-white/10">
          <p className="text-sm text-secondary">
            <strong className="text-primary">New here?</strong>
            <br />
            <span className="mt-1 inline-block">
              Imajin identities are created through communities, events, and businesses. Ask your organizer or host for an invitation.
            </span>
          </p>
          <NewsletterSignup />
        </div>

        <div className="mt-4 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30">
          <p className="text-xs text-[#F59E0B]">Your private key never leaves your device.</p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <Suspense fallback={<div className="text-center text-secondary">Loading...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
