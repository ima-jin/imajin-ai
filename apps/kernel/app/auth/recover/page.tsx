'use client';

import { useState } from 'react';
import Link from 'next/link';
import { generateKeypair, sign } from '@/src/lib/auth/browser-keys';

type Step = 'form' | 'backup' | 'done';

interface NewKeypair {
  did: string;
  publicKey: string;
  privateKey: string;
}

export default function RecoverPage() {
  const [did, setDid] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [keypair, setKeypair] = useState<NewKeypair | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const trimmedDid = did.trim();
      const trimmedCode = code.trim();
      if (!trimmedDid || !trimmedCode) {
        throw new Error('Enter your DID and a recovery code.');
      }

      // 1. Generate a fresh keypair locally. The private key never leaves
      //    this browser — recovery only ever authorizes this new public key.
      const newKeypair = await generateKeypair();

      // 2. Get a server challenge tied to this DID.
      const challengeRes = await fetch(`/auth/api/recovery-codes/challenge?did=${encodeURIComponent(trimmedDid)}`);
      const challengeBody = await challengeRes.json().catch(() => ({}));
      if (!challengeRes.ok) {
        throw new Error(challengeBody.error || 'Could not start recovery — check your DID.');
      }
      const { challengeId, challenge } = challengeBody as { challengeId: string; challenge: string };

      // 3. Prove possession of the new key by signing that challenge.
      const proofOfNewKey = await sign(challenge, newKeypair.privateKey);

      // 4. Redeem the code — authorizes rotation to the new key.
      const verifyRes = await fetch('/auth/api/recovery-codes/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did: trimmedDid,
          code: trimmedCode,
          newPublicKey: newKeypair.publicKey,
          challengeId,
          proofOfNewKey,
        }),
      });
      const verifyBody = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok) {
        throw new Error(verifyBody.error || 'Recovery failed. Check your code and try again.');
      }

      setKeypair({ did: trimmedDid, publicKey: newKeypair.publicKey, privateKey: newKeypair.privateKey });
      setStep('backup');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery failed');
    } finally {
      setLoading(false);
    }
  }

  function downloadKey() {
    if (!keypair) return;
    const content = JSON.stringify({
      did: keypair.did,
      keypair: { publicKey: keypair.publicKey, privateKey: keypair.privateKey },
      exportedAt: new Date().toISOString(),
      warning: 'This file contains your private key. Anyone with this file can access your identity. Store it somewhere safe.',
    }, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'imajin-recovered-key.json';
    a.click();
    URL.revokeObjectURL(url);
    setKeySaved(true);
  }

  function finishBackup() {
    if (!keypair) return;
    localStorage.setItem('imajin_keypair', JSON.stringify({ publicKey: keypair.publicKey, privateKey: keypair.privateKey }));
    localStorage.setItem('imajin_did', keypair.did);
    setStep('done');
  }

  if (step === 'backup' && keypair) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md">
          <div className="text-center mb-6">
            <div className="text-5xl mb-4">🔐</div>
            <h1 className="text-2xl font-bold mb-2">Back up your new key</h1>
            <p className="text-gray-500 dark:text-gray-400">Recovery succeeded. Your account now uses this fresh key.</p>
          </div>

          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl p-4 mb-6">
            <p className="text-red-800 dark:text-red-200 font-semibold text-sm mb-2">
              ⚠️ This is your only chance to back up this key
            </p>
            <p className="text-red-700 dark:text-red-300 text-sm">
              All other devices and sessions have been signed out. Your old recovery codes have been invalidated —
              generate a new set from Security settings once you&apos;re signed in.
            </p>
          </div>

          <button type="button"
            onClick={downloadKey}
            className="w-full py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition mb-3 flex items-center justify-center gap-2"
          >
            📥 Download Backup Key
          </button>

          <button type="button"
            onClick={finishBackup}
            disabled={!keySaved}
            className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition"
          >
            ✓ Continue to sign in
          </button>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md text-center">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-2xl font-bold mb-3">Your account has been recovered</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            You can now sign in with your new key on this device.
          </p>
          <Link
            href="/auth/login"
            className="block w-full py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition text-center"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2 text-center">Lost your key?</h1>
        <p className="text-gray-500 dark:text-gray-400 text-center mb-6 text-sm">
          A fresh keypair is generated in this browser and never leaves it. A valid recovery code authorizes your
          account to rotate to it.
        </p>

        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 rounded-lg text-xs mb-6">
          Recovery codes are verified by our server, not by cryptographic proof — this path is not trustless
          (the same trust class as an email magic link).
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="recover-did" className="block text-sm font-medium mb-1">Your DID</label>
            <input
              id="recover-did"
              type="text"
              value={did}
              onChange={(e) => setDid(e.target.value)}
              placeholder="did:imajin:..."
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 font-mono text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="recover-code" className="block text-sm font-medium mb-1">Recovery code</label>
            <input
              id="recover-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 font-mono text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent"
            />
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
            {loading ? 'Recovering…' : 'Recover account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Remembered your key?{' '}
          <Link href="/auth/login" className="text-orange-500 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
