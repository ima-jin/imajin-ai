'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const CONNECTIONS_URL = `${SERVICE_PREFIX}connections.${DOMAIN}`;

// Ed25519 utilities - using noble/ed25519 via script
async function generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
  const privateKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(privateKeyBytes);
  
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha512');
  ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
  
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
  
  return {
    privateKey: bytesToHex(privateKeyBytes),
    publicKey: bytesToHex(publicKeyBytes),
  };
}

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

interface InviteInfo {
  fromHandle?: string;
  fromDid: string;
  note?: string;
}

export default function RegisterPageWrapper() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
        <p className="text-gray-500 dark:text-gray-400">Loading…</p>
      </div>
    }>
      <RegisterPage />
    </Suspense>
  );
}

function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteCode = searchParams.get('invite');
  const redirectUrl = searchParams.get('redirect');

  const [handle, setHandle] = useState('');
  const [name, setDisplayName] = useState('');
  const [type, setType] = useState<'human' | 'agent'>('human');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);

  // Validate invite code on mount
  useEffect(() => {
    if (!inviteCode) {
      setChecking(false);
      setInviteValid(false);
      return;
    }

    fetch(`${CONNECTIONS_URL}/api/invites/${inviteCode}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !data.used) {
          setInviteValid(true);
          setInviteInfo({
            fromHandle: data.fromHandle,
            fromDid: data.fromDid,
            note: data.note,
          });
        } else {
          setInviteValid(false);
        }
      })
      .catch(() => setInviteValid(false))
      .finally(() => setChecking(false));
  }, [inviteCode]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const keypair = await generateKeypair();
      
      const payload = {
        publicKey: keypair.publicKey,
        handle: handle.toLowerCase(),
        name,
        type,
      };
      
      const signature = await sign(JSON.stringify(payload), keypair.privateKey);
      
      // Register with invite code
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          signature,
          inviteCode: inviteCode || undefined,
        }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }
      
      // Store keypair in localStorage
      localStorage.setItem('imajin:keypair', JSON.stringify({
        publicKey: keypair.publicKey,
        privateKey: keypair.privateKey,
        did: data.did,
        handle: data.handle,
      }));

      // If there's a redirect (e.g. back to invite page), go there
      if (redirectUrl) {
        window.location.href = redirectUrl;
      } else if (inviteCode) {
        // Auto-accept was done server-side, go to connections
        window.location.href = CONNECTIONS_URL;
      } else {
        router.push('/');
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
        <p className="text-gray-500 dark:text-gray-400">Checking invite…</p>
      </div>
    );
  }

  // No invite code or invalid invite — show invite-only message
  if (!inviteValid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md text-center">
          <div className="text-6xl mb-6">🟠</div>
          <h1 className="text-2xl font-bold mb-3">Imajin is invite-only</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            You need an invite from an existing member to join the network.
            Each connection is intentional.
          </p>
          {inviteCode && (
            <p className="text-red-500 dark:text-red-400 text-sm mb-6">
              This invite link is invalid or has already been used.
            </p>
          )}
          <div className="space-y-3">
            <Link
              href="/login"
              className="block w-full py-3 bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition text-center"
            >
              Already have an account? Login
            </Link>
            <a
              href={`${SERVICE_PREFIX}www.${DOMAIN}`}
              className="block w-full py-3 bg-white/10 hover:bg-white/20 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition text-center"
            >
              Learn about Imajin
            </a>
          </div>
        </div>
      </div>
    );
  }

  const inviterDisplay = inviteInfo?.fromHandle ? `@${inviteInfo.fromHandle}` : inviteInfo?.fromDid.slice(0, 20) + '...';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2 text-center">Create Identity</h1>
        <p className="text-gray-500 dark:text-gray-400 text-center mb-2">
          You&apos;ve been invited by <span className="text-white font-medium">{inviterDisplay}</span>
        </p>
        {inviteInfo?.note && (
          <p className="text-gray-400 text-center text-sm mb-6 italic">
            &ldquo;{inviteInfo.note}&rdquo;
          </p>
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
                pattern="[a-z0-9_]{3,30}"
                required
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500 focus:border-transparent"
              />
            </div>
            <p className="text-xs text-gray-400 mt-1">3-30 characters, lowercase letters, numbers, underscores</p>
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-1">Display Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your Name"
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500 focus:border-transparent"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-1">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'human' | 'agent')}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500 focus:border-transparent"
            >
              <option value="human">👤 Human</option>
              <option value="agent">🤖 Agent</option>
            </select>
          </div>
          
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
              {error}
            </div>
          )}
          
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-medium rounded-lg transition"
          >
            {loading ? 'Creating...' : 'Create Identity & Connect'}
          </button>
        </form>
        
        <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Already have an identity?{' '}
          <Link
            href={`/login${inviteCode ? `?invite=${inviteCode}${redirectUrl ? `&redirect=${encodeURIComponent(redirectUrl)}` : ''}` : ''}`}
            className="text-orange-500 hover:underline"
          >
            Sign in
          </Link>
        </p>
        
        <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <strong>Note:</strong> Your keypair will be stored in this browser.
            If you clear your browser data, you will lose access to this identity.
            Export your keys to back them up.
          </p>
        </div>
      </div>
    </div>
  );
}
