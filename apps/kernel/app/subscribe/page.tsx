'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';

function SubscribeContent() {
  const searchParams = useSearchParams();
  const from = searchParams.get('from') || 'direct';
  const source = `subscribe-${from}`;

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('loading');

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus('success');
        setMessage(
          data.status === 'pending_verification'
            ? 'Check your inbox to confirm your email.'
            : data.status === 'already_subscribed'
            ? "You're already on the list!"
            : data.message || "You're on the list!"
        );
        setEmail('');
      } else {
        setStatus('error');
        setMessage(data.error || 'Something went wrong');
      }
    } catch {
      setStatus('error');
      setMessage('Failed to connect. Please try again.');
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      {/* Title */}
      <h1 className="text-3xl md:text-4xl font-light tracking-tight mb-2 font-mono">
        Stay in the loop
      </h1>
      <p className="text-secondary text-center max-w-md mb-8">
        We're building sovereign identity and profile infrastructure.
        Sign up to get notified when it's ready.
      </p>

      {/* Form */}
      {status === 'success' ? (
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-success mb-2">{message}</p>
          <p className="text-secondary text-sm">We'll be in touch.</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <div className="flex flex-col gap-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              disabled={status === 'loading'}
              className="w-full px-4 py-3 bg-surface-surface border border-white/10 focus:outline-none focus:border-imajin-orange transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={status === 'loading'}
              style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="w-full px-4 py-3 hover:brightness-110 disabled:bg-imajin-orange/50 text-primary font-medium transition-colors"
            >
              {status === 'loading' ? 'Subscribing...' : 'Subscribe'}
            </button>
          </div>

          {status === 'error' && (
            <p className="mt-4 text-error text-sm text-center">{message}</p>
          )}
        </form>
      )}

      {/* Note */}
      <p className="mt-8 text-xs text-muted text-center max-w-sm">
        No spam. Just meaningful updates about our progress toward sovereign infrastructure.
      </p>
    </main>
  );
}

export default function SubscribePage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-secondary">Loading…</p>
      </main>
    }>
      <SubscribeContent />
    </Suspense>
  );
}
