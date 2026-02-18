'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3003';
const PROFILE_URL = process.env.NEXT_PUBLIC_PROFILE_URL || 'http://localhost:3005';

// Ed25519 signing using Web Crypto + noble
async function generateKeypair() {
  const { utils, getPublicKey } = await import('@noble/ed25519');
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKey(privateKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

async function signChallenge(challenge: string, privateKeyHex: string) {
  const { sign } = await import('@noble/ed25519');
  const privateKey = hexToBytes(privateKeyHex);
  const message = new TextEncoder().encode(challenge);
  const signature = await sign(message, privateKey);
  return bytesToHex(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

type Step = 'form' | 'creating' | 'success' | 'error';

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<any>(null);
  
  // Form state
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [bio, setBio] = useState('');
  const [displayType, setDisplayType] = useState<'human' | 'agent'>('human');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStep('creating');
    setError('');

    try {
      // 1. Generate keypair
      const keypair = await generateKeypair();
      const did = `did:imajin:${keypair.publicKey.slice(0, 16)}`;

      // 2. Register with auth
      const regRes = await fetch(`${AUTH_URL}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey,
          type: displayType,
          name: displayName,
        }),
      });
      const regData = await regRes.json();
      if (regData.error) throw new Error(regData.error);

      // 3. Get challenge
      const challengeRes = await fetch(`${AUTH_URL}/api/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: did }),
      });
      const challengeData = await challengeRes.json();
      if (challengeData.error) throw new Error(challengeData.error);

      // 4. Sign challenge
      const signature = await signChallenge(challengeData.challenge, keypair.privateKey);

      // 5. Authenticate
      const authRes = await fetch(`${AUTH_URL}/api/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: did,
          challengeId: challengeData.challengeId,
          signature,
        }),
      });
      const authData = await authRes.json();
      if (authData.error) throw new Error(authData.error);

      // 6. Create profile
      const profileRes = await fetch(`${PROFILE_URL}/api/profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authData.token}`,
        },
        body: JSON.stringify({
          displayName,
          displayType,
          handle: handle || undefined,
          bio: bio || undefined,
        }),
      });
      const profileData = await profileRes.json();
      if (profileData.error) throw new Error(profileData.error);

      // Store keypair in localStorage (with warning)
      localStorage.setItem('imajin_keypair', JSON.stringify(keypair));
      localStorage.setItem('imajin_token', authData.token);
      localStorage.setItem('imajin_did', did);

      setProfile(profileData);
      setStep('success');

    } catch (err: any) {
      setError(err.message || 'Something went wrong');
      setStep('error');
    }
  }

  if (step === 'success' && profile) {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-2xl font-bold mb-2">Welcome to Imajin!</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Your sovereign identity has been created.
          </p>
          
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm text-gray-500 mb-1">Your DID</p>
            <p className="font-mono text-xs break-all">{profile.did}</p>
          </div>

          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm font-semibold text-orange-800 dark:text-orange-200 mb-1">
              ⚠️ Important: Save Your Keys
            </p>
            <p className="text-xs text-orange-700 dark:text-orange-300">
              Your private key is stored in this browser. If you clear your data, you'll lose access.
              We'll add key export soon.
            </p>
          </div>

          <button
            onClick={() => router.push(`/${profile.handle || profile.did}`)}
            className="w-full px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-semibold"
          >
            View Your Profile →
          </button>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          <div className="text-6xl mb-4">😕</div>
          <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
          <p className="text-red-500 mb-6">{error}</p>
          <button
            onClick={() => setStep('form')}
            className="px-6 py-3 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (step === 'creating') {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          <div className="text-6xl mb-4 animate-pulse">🔐</div>
          <h1 className="text-2xl font-bold mb-2">Creating your identity...</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Generating keypair and registering on the network.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center">Join Imajin</h1>
        <p className="text-gray-600 dark:text-gray-400 text-center mb-6">
          Create your sovereign identity. No passwords, no email.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Display Name *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-orange-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Handle</label>
            <div className="flex items-center">
              <span className="text-gray-500 mr-1">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="yourhandle"
                pattern="[a-z0-9_]{3,30}"
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-orange-500 focus:border-transparent"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">3-30 chars, lowercase, numbers, underscores</p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell us about yourself..."
              rows={3}
              maxLength={500}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-orange-500 focus:border-transparent resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">I am a...</label>
            <div className="flex gap-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  name="type"
                  value="human"
                  checked={displayType === 'human'}
                  onChange={() => setDisplayType('human')}
                  className="mr-2"
                />
                👤 Human
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  name="type"
                  value="agent"
                  checked={displayType === 'agent'}
                  onChange={() => setDisplayType('agent')}
                  className="mr-2"
                />
                🤖 Agent
              </label>
            </div>
          </div>

          <button
            type="submit"
            className="w-full px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-semibold"
          >
            Create Identity
          </button>
        </form>

        <p className="text-xs text-gray-500 text-center mt-6">
          By creating an identity, you generate a cryptographic keypair.
          <br />
          No data leaves your device until you submit.
        </p>
      </div>
    </div>
  );
}
