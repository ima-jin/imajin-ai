'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as ed from '@noble/ed25519';

// Base58 encoding for DIDs
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return encoded || '1';
}

async function generateKeypair() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    privateKey: Buffer.from(privateKey).toString('hex'),
    publicKey: Buffer.from(publicKey).toString('hex'),
    publicKeyBytes: publicKey,
  };
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
  const [avatar, setAvatar] = useState('👤');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStep('creating');
    setError('');

    try {
      // 1. Generate keypair
      const keypair = await generateKeypair();
      const publicKeyBase58 = base58Encode(keypair.publicKeyBytes);
      const did = `did:imajin:${publicKeyBase58}`;

      // 2. Register profile
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey,
          handle: handle || undefined,
          displayName,
          bio: bio || undefined,
          avatar: avatar || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      // 3. Store keypair in localStorage
      localStorage.setItem('imajin_keypair', JSON.stringify({
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
      }));
      localStorage.setItem('imajin_did', did);

      setProfile(data);
      setStep('success');

    } catch (err: any) {
      console.error('Registration error:', err);
      setError(err.message || 'Something went wrong');
      setStep('error');
    }
  }

  function downloadKeys() {
    const keypair = localStorage.getItem('imajin_keypair');
    const did = localStorage.getItem('imajin_did');
    if (!keypair || !did) return;

    const backup = {
      did,
      keypair: JSON.parse(keypair),
      exportedAt: new Date().toISOString(),
      warning: 'Keep this file safe. Anyone with access can control your identity.',
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `imajin-keys-${did.slice(-8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (step === 'success' && profile) {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="text-6xl mb-4">🟠</div>
          <h1 className="text-2xl font-bold mb-2 text-white">Welcome to Imajin!</h1>
          <p className="text-gray-400 mb-6">
            Your sovereign identity has been created.
          </p>

          <div className="bg-black/50 rounded-lg p-4 mb-6 text-left border border-gray-800">
            <p className="text-sm text-gray-500 mb-1">Your DID</p>
            <p className="font-mono text-xs break-all text-gray-300">{profile.did}</p>
          </div>

          <div className="bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm font-semibold text-[#F59E0B] mb-2">
              🔐 Back Up Your Keys Now
            </p>
            <p className="text-xs text-gray-300 mb-3">
              Your private key is only stored in this browser. If you clear your data or lose this device,
              <strong> you will permanently lose access to your identity.</strong>
            </p>
            <button
              onClick={downloadKeys}
              className="w-full px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition text-sm font-medium"
            >
              ⬇️ Download Backup Keys
            </button>
          </div>

          <button
            onClick={() => router.push(`/${profile.handle || profile.did}`)}
            className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold"
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
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="text-6xl mb-4">😕</div>
          <h1 className="text-2xl font-bold mb-2 text-white">Something went wrong</h1>
          <p className="text-red-400 mb-6">{error}</p>
          <button
            onClick={() => setStep('form')}
            className="px-6 py-3 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition"
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
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="text-6xl mb-4 animate-pulse">🔐</div>
          <h1 className="text-2xl font-bold mb-2 text-white">Creating your identity...</h1>
          <p className="text-gray-400">
            Generating keypair and registering on the network.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-white">Join Imajin</h1>
        <p className="text-gray-400 text-center mb-6">
          Create your sovereign identity. No passwords, no email.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Display Name *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Handle</label>
            <div className="flex items-center">
              <span className="text-gray-500 mr-1">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9\-]/g, ''))}
                placeholder="yourhandle"
                pattern="[a-z0-9\-]{3,30}"
                className="flex-1 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">3-30 chars, lowercase, alphanumeric + hyphens</p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Bio (optional)</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell us about yourself..."
              rows={3}
              maxLength={500}
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Avatar (emoji or URL)</label>
            <input
              type="text"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              placeholder="👤 or https://..."
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold"
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
