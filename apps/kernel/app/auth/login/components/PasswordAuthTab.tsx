'use client';

import { useState } from 'react';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

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
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  return encoded || '1';
}

/**
 * Decode base64 string to Uint8Array.
 */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Client-side PBKDF2 → AES-GCM decryption for stored keys.
 * Format: base64-encoded (first 12 bytes = IV, rest = ciphertext). Salt is base64-encoded separately.
 */
async function decryptStoredKey(encryptedKeyB64: string, saltB64: string, password: string): Promise<string> {
  const salt = base64ToBytes(saltB64);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const derivedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  // Parse: first 12 bytes = IV, rest = ciphertext
  const combined = base64ToBytes(encryptedKeyB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derivedKey, ciphertext);
  return new TextDecoder().decode(decrypted);
}

interface PasswordAuthTabProps {
  nextUrl: string | null;
  onMfaRequired: (data: { methods: string[]; challengeToken: string; did: string }) => void;
  onSuccess: (did: string) => void;
}

interface StoredKeyData {
  did: string;
  encryptedKey: string;
  salt: string;
  keyDerivation: string;
}

export default function PasswordAuthTab({ nextUrl, onMfaRequired, onSuccess }: PasswordAuthTabProps) {
  const [step, setStep] = useState<'identifier' | 'password'>('identifier');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [storedKeyData, setStoredKeyData] = useState<StoredKeyData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleIdentifierSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const cleanHandle = handle.trim().replace(/^@/, '');
      const res = await fetch(`/api/account/methods?handle=${encodeURIComponent(cleanHandle)}&includeKey=true`);

      if (!res.ok) {
        if (res.status === 404) {
          setError('Account not found. Check your handle and try again.');
        } else {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Failed to look up account');
        }
        return;
      }

      const data = await res.json();

      if (!data.hasStoredKey) {
        setError('No stored key found for this account. Use key import to sign in.');
        return;
      }

      setStoredKeyData({
        did: data.did,
        encryptedKey: data.encryptedKey,
        salt: data.salt,
        keyDerivation: data.keyDerivation || 'pbkdf2',
      });
      setStep('password');
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!storedKeyData) return;
    setError('');
    setLoading(true);

    try {
      // Decrypt stored key client-side
      let privateKeyHex: string;
      try {
        const decrypted = await decryptStoredKey(storedKeyData.encryptedKey, storedKeyData.salt, password);

        // The setup encrypts the full localStorage JSON: {"privateKey":"...","publicKey":"..."}
        // Try parsing as JSON first, fall back to raw hex
        try {
          const parsed = JSON.parse(decrypted);
          privateKeyHex = parsed.privateKey || parsed.keypair?.privateKey || decrypted;
        } catch {
          privateKeyHex = decrypted;
        }
      } catch {
        setError('Incorrect password. Please try again.');
        return;
      }

      if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex.trim())) {
        setError('Incorrect password — decrypted key is invalid.');
        return;
      }

      privateKeyHex = privateKeyHex.trim();

      // Now do challenge-response login
      const ed = await import('@noble/ed25519');
      const { sha512 } = await import('@noble/hashes/sha2.js');
      ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

      const privateKeyBytes = hexToBytes(privateKeyHex);
      const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
      const publicKeyHex = Array.from(publicKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const publicKeyBase58 = base58Encode(publicKeyBytes);
      const derivedDid = `did:imajin:${publicKeyBase58}`;

      const challengeRes = await fetch('/api/login/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: storedKeyData.did }),
      });

      if (!challengeRes.ok) {
        const body = await challengeRes.json().catch(() => ({}));
        setError(body.error || 'Failed to get login challenge');
        return;
      }

      const { challengeId, challenge, hasDfosChain } = await challengeRes.json();
      // Sign the challenge hex string as UTF-8 bytes (matches verifySignature in lib/crypto.ts)
      const challengeBytes = new TextEncoder().encode(challenge);
      const signatureBytes = await ed.signAsync(challengeBytes, privateKeyBytes);
      const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      // If the account has no DFOS chain yet, create a genesis block client-side (non-fatal)
      let dfosChain = null;
      if (!hasDfosChain) {
        try {
          const { createDfosChain } = await import('@/src/lib/auth/dfos-client');
          dfosChain = await createDfosChain({ privateKey: privateKeyHex, publicKey: publicKeyHex });
        } catch (err) {
          console.warn('[dfos] Chain creation failed (non-fatal):', err);
        }
      }

      const verifyRes = await fetch('/api/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, signature, dfosChain }),
      });

      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        setError(body.error || 'Authentication failed');
        return;
      }

      const data = await verifyRes.json();

      if (data.mfaRequired) {
        onMfaRequired({ methods: data.methods, challengeToken: data.challengeToken, did: derivedDid });
        return;
      }

      localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey: privateKeyHex, publicKey: publicKeyHex }));
      localStorage.setItem('imajin_did', derivedDid);
      onSuccess(derivedDid);

    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  if (step === 'password' && storedKeyData) {
    return (
      <div>
        <button
          onClick={() => { setStep('identifier'); setError(''); setPassword(''); }}
          className="text-sm text-gray-500 hover:text-gray-300 transition mb-4 flex items-center gap-1"
        >
          ← Change account
        </button>

        <div className="mb-4 p-3 bg-amber-900/20 border border-amber-700/50 rounded-lg">
          <p className="text-xs text-amber-400">
            Signing in as <strong className="text-amber-300">@{handle.replace(/^@/, '')}</strong>
          </p>
        </div>

        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              autoFocus
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <form onSubmit={handleIdentifierSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1 text-gray-300">Handle</label>
        <input
          type="text"
          value={handle}
          onChange={e => setHandle(e.target.value)}
          placeholder="@yourhandle"
          required
          autoFocus
          className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
        />
      </div>

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !handle.trim()}
        className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Looking up…' : 'Continue'}
      </button>
    </form>
  );
}
