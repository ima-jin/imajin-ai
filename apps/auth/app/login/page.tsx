'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// Sign a message with stored private key
async function sign(message: string, privateKeyHex: string): Promise<string> {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha512');
  ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
  
  const messageBytes = new TextEncoder().encode(message);
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const signature = await ed.signAsync(messageBytes, privateKeyBytes);
  return bytesToHex(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

interface StoredKeypair {
  publicKey: string;
  privateKey: string;
  did: string;
  handle?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [storedKeypair, setStoredKeypair] = useState<StoredKeypair | null>(null);

  useEffect(() => {
    // Check for stored keypair
    const stored = localStorage.getItem('imajin:keypair');
    if (stored) {
      try {
        const keypair = JSON.parse(stored);
        setStoredKeypair(keypair);
        if (keypair.handle) {
          setHandle(keypair.handle);
        }
      } catch {
        // Invalid stored data
      }
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (!storedKeypair) {
        throw new Error('No keypair found. Please register first or import your keys.');
      }

      // Get challenge
      const challengeResponse = await fetch('/api/login/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handle.toLowerCase() }),
      });

      if (!challengeResponse.ok) {
        const data = await challengeResponse.json();
        throw new Error(data.error || 'Failed to get challenge');
      }

      const { challengeId, challenge } = await challengeResponse.json();

      // Sign challenge
      const signature = await sign(challenge, storedKeypair.privateKey);

      // Verify
      const verifyResponse = await fetch('/api/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, signature }),
      });

      if (!verifyResponse.ok) {
        const data = await verifyResponse.json();
        throw new Error(data.error || 'Login failed');
      }

      const data = await verifyResponse.json();

      // Update stored keypair with latest handle
      localStorage.setItem('imajin:keypair', JSON.stringify({
        ...storedKeypair,
        handle: data.handle,
        did: data.did,
      }));

      // Redirect
      const next = new URLSearchParams(window.location.search).get('next');
      router.push(next || '/');

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleAutoLogin() {
    if (!storedKeypair?.handle) return;
    setHandle(storedKeypair.handle);
    // Trigger form submit
    const form = document.querySelector('form');
    if (form) form.requestSubmit();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2 text-center">Sign In</h1>
        <p className="text-gray-500 dark:text-gray-400 text-center mb-6">
          Sign in with your keypair
        </p>

        {storedKeypair && (
          <button
            onClick={handleAutoLogin}
            disabled={loading}
            className="w-full mb-4 py-3 bg-orange-100 dark:bg-orange-900/30 hover:bg-orange-200 dark:hover:bg-orange-900/50 text-orange-600 dark:text-orange-400 font-medium rounded-lg transition flex items-center justify-center gap-2"
          >
            <span className="text-lg">🔑</span>
            Sign in as @{storedKeypair.handle || 'your account'}
          </button>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Handle</label>
            <div className="flex items-center">
              <span className="text-gray-400 mr-1">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="yourname"
                required
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500 focus:border-transparent"
              />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !storedKeypair}
            className="w-full py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-medium rounded-lg transition"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {!storedKeypair && (
          <div className="mt-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
            <p className="text-sm text-yellow-700 dark:text-yellow-400">
              No keypair found in this browser. You need to{' '}
              <Link href="/register" className="underline">
                create an identity
              </Link>{' '}
              or import your existing keys.
            </p>
          </div>
        )}

        <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Don&apos;t have an identity?{' '}
          <Link href="/register" className="text-orange-500 hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
