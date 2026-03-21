'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function importPrivateKey(privateKeyHex: string): Promise<{ success: boolean; error?: string; did?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    return { success: false, error: 'Invalid private key format. Must be 64 hex characters.' };
  }

  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha512');
  ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

  const privateKeyBytes = hexToBytes(privateKeyHex);
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
  const publicKeyHex = Array.from(publicKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const publicKeyBase58 = base58Encode(publicKeyBytes);
  const derivedDid = `did:imajin:${publicKeyBase58}`;

  const payload = JSON.stringify({ publicKey: publicKeyHex, type: 'human' });
  const msgBytes = new TextEncoder().encode(payload);
  const signatureBytes = await ed.signAsync(msgBytes, privateKeyBytes);
  const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Create DFOS identity chain for login-time bridging
  let dfosChain = null;
  try {
    const { createDfosChain } = await import('@/lib/dfos-client');
    dfosChain = await createDfosChain({
      privateKey: privateKeyHex,
      publicKey: publicKeyHex,
    });
  } catch (err) {
    console.warn('DFOS chain creation failed (non-fatal):', err);
  }

  const authResponse = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: publicKeyHex, type: 'human', signature, dfosChain }),
  });

  if (!authResponse.ok) {
    const authError = await authResponse.json();
    return { success: false, error: `Auth failed: ${authError.error || 'Unknown error'}` };
  }

  localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey: privateKeyHex, publicKey: publicKeyHex }));
  localStorage.setItem('imajin_did', derivedDid);

  return { success: true, did: derivedDid };
}

type ImportMethod = 'file' | 'paste';

function LoginForm() {
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get('next');

  const [method, setMethod] = useState<ImportMethod>('file');
  const [privateKeyHex, setPrivateKeyHex] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    // If localStorage says logged in, verify the session is still valid
    const storedDid = localStorage.getItem('imajin_did');
    if (storedDid) {
      // Check if the actual session cookie is still valid
      fetch('/api/session', { credentials: 'include' })
        .then(res => {
          if (res.ok) {
            // Session is valid — redirect to destination
            window.location.href = nextUrl || '/';
          } else {
            // Session expired — clear stale localStorage
            localStorage.removeItem('imajin_did');
            localStorage.removeItem('imajin_keypair');
          }
        })
        .catch(() => {
          // Network error — don't redirect, let them re-login
        });
    }
  }, [nextUrl]);

  async function handleFileSelect(file: File) {
    setError('');
    setLoading(true);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Accept both nested format (v0.2+: { keypair: { privateKey } })
      // and flat format (v0.1: { privateKey })
      const privateKey = data.keypair?.privateKey || data.privateKey;
      if (!privateKey) {
        throw new Error('Invalid backup file format. Missing privateKey.');
      }

      const result = await importPrivateKey(privateKey);

      if (result.success) {
        window.location.href = nextUrl || '/';
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (err: any) {
      console.error('File import failed:', err);
      setError(err.message || 'Failed to import backup file');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasteImport(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await importPrivateKey(privateKeyHex.trim());

      if (result.success) {
        window.location.href = nextUrl || '/';
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (err: any) {
      console.error('Manual import failed:', err);
      setError(err.message || 'Failed to import key');
    } finally {
      setLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);

    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/json') {
      handleFileSelect(file);
    } else {
      setError('Please drop a valid JSON backup file');
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-white">Login / Recovery</h1>
        <p className="text-gray-400 text-center mb-6">
          Import your private key to access your identity
        </p>

        {/* Method selector */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMethod('file')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${
              method === 'file'
                ? 'bg-[#F59E0B] text-black font-medium'
                : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
            }`}
          >
            Import File
          </button>
          <button
            onClick={() => setMethod('paste')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${
              method === 'paste'
                ? 'bg-[#F59E0B] text-black font-medium'
                : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
            }`}
          >
            Paste Key
          </button>
        </div>

        {/* File import */}
        {method === 'file' && (
          <div>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition ${
                dragOver
                  ? 'border-[#F59E0B] bg-[#F59E0B]/10'
                  : 'border-gray-700 hover:border-gray-600'
              }`}
            >
              <div className="text-4xl mb-3">📁</div>
              <p className="text-gray-300 mb-2">Drag & drop your backup file here</p>
              <p className="text-sm text-gray-500 mb-4">or</p>
              <label className="inline-block px-6 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition cursor-pointer font-medium">
                Choose File
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                  }}
                  className="hidden"
                  disabled={loading}
                />
              </label>
            </div>
          </div>
        )}

        {/* Paste key */}
        {method === 'paste' && (
          <form onSubmit={handlePasteImport} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-gray-300">
                Private Key (hex)
              </label>
              <textarea
                value={privateKeyHex}
                onChange={(e) => setPrivateKeyHex(e.target.value)}
                placeholder="64 character hex string..."
                rows={4}
                required
                className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white font-mono text-sm focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
              />
              <p className="text-xs text-gray-500 mt-1">
                Your private key is 64 hexadecimal characters
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || !privateKeyHex.trim()}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Importing...' : 'Import & Login'}
            </button>
          </form>
        )}

        {/* Error display */}
        {error && (
          <div className="mt-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="mt-4 text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F59E0B]"></div>
            <p className="text-sm text-gray-400 mt-2">Importing keys...</p>
          </div>
        )}

        {/* Info box */}
        <div className="mt-6 p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <p className="text-sm text-gray-400">
            <strong className="text-white">Don&apos;t have an account?</strong>
            <br />
            <a
              href="/register"
              className="text-[#F59E0B] hover:underline mt-1 inline-block"
            >
              Create a new identity →
            </a>
          </p>
        </div>

        {/* Security warning */}
        <div className="mt-4 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg">
          <p className="text-xs text-[#F59E0B]">
            🔐 Your private key never leaves your device. It&apos;s only stored locally in your browser.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <Suspense fallback={<div className="text-center text-gray-400">Loading...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
