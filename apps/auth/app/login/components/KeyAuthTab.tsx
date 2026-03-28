'use client';

import { useState } from 'react';

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

interface LoginResult {
  success: boolean;
  error?: string;
  did?: string;
  mfaRequired?: boolean;
  methods?: string[];
  challengeToken?: string;
}

async function loginWithKeypair(privateKeyHex: string): Promise<LoginResult> {
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

  // Try challenge-response login first
  const challengeRes = await fetch('/api/login/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: derivedDid }),
  });

  if (challengeRes.ok) {
    const { challengeId, challenge } = await challengeRes.json();
    // Sign the challenge hex string as UTF-8 bytes (matches verifySignature in lib/crypto.ts)
    const challengeBytes = new TextEncoder().encode(challenge);
    const signatureBytes = await ed.signAsync(challengeBytes, privateKeyBytes);
    const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const verifyRes = await fetch('/api/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    });

    if (verifyRes.ok) {
      const data = await verifyRes.json();
      if (data.mfaRequired) {
        return { success: true, did: derivedDid, mfaRequired: true, methods: data.methods, challengeToken: data.challengeToken };
      }
      localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey: privateKeyHex, publicKey: publicKeyHex }));
      localStorage.setItem('imajin_did', derivedDid);
      return { success: true, did: derivedDid };
    }
  }

  // Fallback: register (for new identities or if challenge fails)
  const payload = JSON.stringify({ publicKey: publicKeyHex, type: 'human' });
  const msgBytes = new TextEncoder().encode(payload);
  const signatureBytes = await ed.signAsync(msgBytes, privateKeyBytes);
  const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  let dfosChain = null;
  try {
    const { createDfosChain } = await import('@/lib/dfos-client');
    dfosChain = await createDfosChain({ privateKey: privateKeyHex, publicKey: publicKeyHex });
  } catch {
    // non-fatal
  }

  const authResponse = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: publicKeyHex, type: 'human', signature, dfosChain }),
  });

  if (!authResponse.ok) {
    const err = await authResponse.json();
    return { success: false, error: err.error || 'Auth failed' };
  }

  localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey: privateKeyHex, publicKey: publicKeyHex }));
  localStorage.setItem('imajin_did', derivedDid);
  return { success: true, did: derivedDid };
}

type ImportMethod = 'file' | 'paste';
type ChainImportMethod = 'file' | 'paste';

interface KeyAuthTabProps {
  nextUrl: string | null;
  onMfaRequired: (data: { methods: string[]; challengeToken: string; did: string }) => void;
  onSuccess: (did: string) => void;
}

export default function KeyAuthTab({ nextUrl, onMfaRequired, onSuccess }: KeyAuthTabProps) {
  const [method, setMethod] = useState<ImportMethod>('file');
  const [privateKeyHex, setPrivateKeyHex] = useState('');
  const [keypairError, setKeypairError] = useState('');
  const [keypairLoading, setKeypairLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showChain, setShowChain] = useState(false);
  const [chainMethod, setChainMethod] = useState<ChainImportMethod>('file');
  const [chainLogText, setChainLogText] = useState('');
  const [chainError, setChainError] = useState('');
  const [chainLoading, setChainLoading] = useState(false);

  async function handleKeyLogin(keyHex: string) {
    const result = await loginWithKeypair(keyHex.trim());
    if (result.success) {
      if (result.mfaRequired && result.methods && result.challengeToken && result.did) {
        onMfaRequired({ methods: result.methods, challengeToken: result.challengeToken, did: result.did });
      } else if (result.did) {
        onSuccess(result.did);
      }
    } else {
      setKeypairError(result.error || 'Import failed');
    }
  }

  async function handleFileSelect(file: File) {
    setKeypairError('');
    setKeypairLoading(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const privateKey = data.keypair?.privateKey || data.privateKey;
      if (!privateKey) throw new Error('Invalid backup file format. Missing privateKey.');
      await handleKeyLogin(privateKey);
    } catch (err: any) {
      setKeypairError(err.message || 'Failed to import backup file');
    } finally {
      setKeypairLoading(false);
    }
  }

  async function handlePasteImport(e: React.FormEvent) {
    e.preventDefault();
    setKeypairError('');
    setKeypairLoading(true);
    try {
      await handleKeyLogin(privateKeyHex);
    } catch (err: any) {
      setKeypairError(err.message || 'Failed to import key');
    } finally {
      setKeypairLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/json') {
      handleFileSelect(file);
    } else {
      setKeypairError('Please drop a valid JSON backup file');
    }
  }

  // Chain login
  async function presentChain(chainLog: string[]) {
    setChainLoading(true);
    setChainError('');
    try {
      const res = await fetch('/api/identity/present-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainLog }),
      });
      if (res.ok) {
        const data = await res.json();
        const did = data.identity?.id;
        if (did) {
          localStorage.setItem('imajin_did', did);
          onSuccess(did);
        }
      } else {
        const body = await res.json().catch(() => ({}));
        setChainError(body.error || 'Chain verification failed. Please check your chain log.');
      }
    } catch {
      setChainError('Network error. Please check your connection and try again.');
    } finally {
      setChainLoading(false);
    }
  }

  async function handleChainFileSelect(file: File) {
    setChainError('');
    try {
      const text = await file.text();
      let chainLog: string[];
      try {
        const parsed = JSON.parse(text);
        chainLog = Array.isArray(parsed) ? parsed : parsed.log;
        if (!Array.isArray(chainLog)) throw new Error('Expected a JSON array or { log: [...] }');
      } catch {
        throw new Error('Invalid chain file. Expected a JSON array of chain entries.');
      }
      await presentChain(chainLog);
    } catch (err: any) {
      setChainError(err.message || 'Failed to read chain file');
    }
  }

  async function handleChainPasteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChainError('');
    try {
      const parsed = JSON.parse(chainLogText.trim());
      const chainLog = Array.isArray(parsed) ? parsed : parsed.log;
      if (!Array.isArray(chainLog)) throw new Error('Expected a JSON array');
      await presentChain(chainLog);
    } catch (err: any) {
      setChainError(err.message || 'Invalid JSON. Paste a chain log array.');
    }
  }

  if (showChain) {
    return (
      <div>
        <button
          onClick={() => { setShowChain(false); setChainError(''); setChainLogText(''); }}
          className="text-sm text-gray-500 hover:text-gray-300 transition mb-4 flex items-center gap-1"
        >
          ← Back to key login
        </button>

        <h2 className="text-lg font-semibold mb-2 text-white">Present identity chain</h2>
        <p className="text-gray-400 text-sm mb-4">Log in with a chain from any compatible network</p>

        <div className="mb-4 p-3 bg-blue-900/20 border border-blue-700/50 rounded-lg">
          <p className="text-xs text-blue-400">
            External chain identities receive <strong>preliminary</strong> trust tier on this network.
          </p>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setChainMethod('file')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${chainMethod === 'file' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`}
          >
            Upload File
          </button>
          <button
            onClick={() => setChainMethod('paste')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${chainMethod === 'paste' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`}
          >
            Paste Log
          </button>
        </div>

        {chainMethod === 'file' && (
          <div className="border-2 border-dashed border-gray-700 hover:border-gray-600 rounded-lg p-8 text-center transition">
            <div className="text-4xl mb-3">🔗</div>
            <p className="text-gray-300 mb-2">Upload your chain log file</p>
            <p className="text-sm text-gray-500 mb-4">JSON file exported from your identity wallet</p>
            <label className="inline-block px-6 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition cursor-pointer font-medium">
              Choose File
              <input
                type="file"
                accept="application/json,.json"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleChainFileSelect(f); }}
                className="hidden"
                disabled={chainLoading}
              />
            </label>
          </div>
        )}

        {chainMethod === 'paste' && (
          <form onSubmit={handleChainPasteSubmit} className="space-y-4">
            <textarea
              value={chainLogText}
              onChange={e => setChainLogText(e.target.value)}
              placeholder={'["eyJhbGciOiJFZERTQSJ9...", ...]'}
              rows={6}
              required
              autoFocus
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white font-mono text-xs focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
            />
            <button
              type="submit"
              disabled={chainLoading || !chainLogText.trim()}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {chainLoading ? 'Verifying…' : 'Verify & Sign In'}
            </button>
          </form>
        )}

        {chainError && (
          <div className="mt-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
            <p className="text-sm text-red-400">{chainError}</p>
          </div>
        )}
        {chainLoading && (
          <div className="mt-4 text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F59E0B]"></div>
            <p className="text-sm text-gray-400 mt-2">Verifying chain…</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Import method selector */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setMethod('file')}
          className={`flex-1 px-4 py-2 rounded-lg transition ${method === 'file' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`}
        >
          Import File
        </button>
        <button
          onClick={() => setMethod('paste')}
          className={`flex-1 px-4 py-2 rounded-lg transition ${method === 'paste' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`}
        >
          Paste Key
        </button>
      </div>

      {/* File import */}
      {method === 'file' && (
        <div
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition ${dragOver ? 'border-[#F59E0B] bg-[#F59E0B]/10' : 'border-gray-700 hover:border-gray-600'}`}
        >
          <div className="text-4xl mb-3">📁</div>
          <p className="text-gray-300 mb-2">Drag & drop your backup file</p>
          <p className="text-sm text-gray-500 mb-4">or</p>
          <label className="inline-block px-6 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition cursor-pointer font-medium">
            Choose File
            <input
              type="file"
              accept="application/json"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
              className="hidden"
              disabled={keypairLoading}
            />
          </label>
        </div>
      )}

      {/* Paste key */}
      {method === 'paste' && (
        <form onSubmit={handlePasteImport} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Private Key (hex)</label>
            <textarea
              value={privateKeyHex}
              onChange={e => setPrivateKeyHex(e.target.value)}
              placeholder="64 character hex string..."
              rows={3}
              required
              autoFocus
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white font-mono text-sm focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
            />
          </div>
          <button
            type="submit"
            disabled={keypairLoading || !privateKeyHex.trim()}
            className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {keypairLoading ? 'Importing…' : 'Import & Sign In'}
          </button>
        </form>
      )}

      {keypairError && (
        <div className="mt-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
          <p className="text-sm text-red-400">{keypairError}</p>
        </div>
      )}

      {keypairLoading && (
        <div className="mt-4 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F59E0B]"></div>
          <p className="text-sm text-gray-400 mt-2">Verifying identity…</p>
        </div>
      )}

      {/* Chain login */}
      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-800"></div>
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="px-3 bg-[#0a0a0a] text-gray-500">external chain?</span>
        </div>
      </div>
      <button
        onClick={() => setShowChain(true)}
        className="w-full px-4 py-3 border border-gray-700 text-gray-300 rounded-lg hover:bg-gray-900 transition text-sm"
      >
        Log in with identity chain
      </button>
    </div>
  );
}
