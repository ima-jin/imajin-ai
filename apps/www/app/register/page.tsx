'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function RegisterPage() {
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
        body: JSON.stringify({ email }),
      });
      
      const data = await res.json();
      
      if (res.ok) {
        setStatus('success');
        setMessage(data.message || 'You\'re on the list!');
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
      {/* Back link */}
      <Link 
        href="/" 
        className="absolute top-8 left-8 text-gray-500 hover:text-gray-300 transition-colors"
      >
        ← Back
      </Link>

      {/* Orb */}
      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 shadow-[0_0_40px_rgba(255,107,53,0.3)] mb-8" />
      
      {/* Title */}
      <h1 className="text-3xl md:text-4xl font-light tracking-tight mb-2">
        Register Interest
      </h1>
      <p className="text-gray-400 text-center max-w-md mb-8">
        We're building sovereign identity and profile infrastructure.
        Sign up to get notified when it's ready.
      </p>
      
      {/* Form */}
      {status === 'success' ? (
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-green-400 mb-2">{message}</p>
          <p className="text-gray-500 text-sm">We'll be in touch.</p>
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
              className="w-full px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg focus:outline-none focus:border-orange-500 transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full px-4 py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/50 text-white font-medium rounded-lg transition-colors"
            >
              {status === 'loading' ? 'Subscribing...' : 'Notify Me'}
            </button>
          </div>
          
          {status === 'error' && (
            <p className="mt-4 text-red-400 text-sm text-center">{message}</p>
          )}
        </form>
      )}
      
      {/* Note */}
      <p className="mt-8 text-xs text-gray-600 text-center max-w-sm">
        No spam. Just meaningful updates about our progress toward sovereign infrastructure.
      </p>
    </main>
  );
}
