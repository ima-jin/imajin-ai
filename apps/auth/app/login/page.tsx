'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
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

type ViewState = 'email' | 'email-sent' | 'keypair' | 'login-mfa';
type ImportMethod = 'file' | 'paste';

const RESEND_COOLDOWN_SECONDS = 60;

function LoginForm() {
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get('next');

  // View routing
  const [view, setView] = useState<ViewState>('email');
  const [fromEmailForbidden, setFromEmailForbidden] = useState(false);

  // Email view state
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  // Email-sent cooldown
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keypair view state
  const [method, setMethod] = useState<ImportMethod>('file');
  const [privateKeyHex, setPrivateKeyHex] = useState('');
  const [keypairError, setKeypairError] = useState('');
  const [keypairLoading, setKeypairLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    // If localStorage says logged in, verify the session is still valid
    const storedDid = localStorage.getItem('imajin_did');
    if (storedDid) {
      fetch('/api/session', { credentials: 'include' })
        .then(res => {
          if (res.ok) {
            window.location.href = nextUrl || '/';
          } else {
            localStorage.removeItem('imajin_did');
            localStorage.removeItem('imajin_keypair');
          }
        })
        .catch(() => {});
    }
  }, [nextUrl]);

  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  function startResendCooldown() {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    cooldownRef.current = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function sendMagicLink(targetEmail: string) {
    setEmailLoading(true);
    setEmailError('');

    try {
      const res = await fetch('/api/magic/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, redirectUrl: nextUrl }),
      });

      if (res.ok) {
        setView('email-sent');
        startResendCooldown();
      } else if (res.status === 403) {
        setFromEmailForbidden(true);
        setView('keypair');
      } else if (res.status === 429) {
        setEmailError('Too many attempts. Please wait a moment before trying again.');
      } else {
        const body = await res.json().catch(() => ({}));
        setEmailError(body.error || 'Something went wrong. Please try again.');
      }
    } catch {
      setEmailError('Network error. Please check your connection and try again.');
    } finally {
      setEmailLoading(false);
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    await sendMagicLink(email.trim());
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    await sendMagicLink(email.trim());
  }

  async function handleFileSelect(file: File) {
    setKeypairError('');
    setKeypairLoading(true);

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
        setKeypairError(result.error || 'Import failed');
      }
    } catch (err: any) {
      console.error('File import failed:', err);
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
      const result = await importPrivateKey(privateKeyHex.trim());

      if (result.success) {
        window.location.href = nextUrl || '/';
      } else {
        setKeypairError(result.error || 'Import failed');
      }
    } catch (err: any) {
      console.error('Manual import failed:', err);
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

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  function goBackToEmail() {
    setFromEmailForbidden(false);
    setKeypairError('');
    setView('email');
  }

  // ── Email view ──────────────────────────────────────────────────────────────
  if (view === 'email') {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h1 className="text-2xl font-bold mb-2 text-center text-white">Welcome back</h1>
          <p className="text-gray-400 text-center mb-6">
            Enter your email to continue
          </p>

          <form onSubmit={handleEmailSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-1 text-gray-300">
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                className="w-full px-4 py-3 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent outline-none"
              />
            </div>

            {emailError && (
              <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
                <p className="text-sm text-red-400">{emailError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={emailLoading || !email.trim()}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {emailLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-black"></span>
                  Sending…
                </span>
              ) : 'Continue'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => { setFromEmailForbidden(false); setView('keypair'); }}
              className="text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Use key directly →
            </button>
          </div>

          <div className="mt-6 p-4 bg-gray-900 border border-gray-800 rounded-lg">
            <p className="text-sm text-gray-400">
              <strong className="text-white">Don&apos;t have an account?</strong>
              <br />
              <a href="/register" className="text-[#F59E0B] hover:underline mt-1 inline-block">
                Create a new identity →
              </a>
            </p>
          </div>

          <div className="mt-4 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg">
            <p className="text-xs text-[#F59E0B]">
              🔐 Your private key never leaves your device. It&apos;s only stored locally in your browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Email-sent view ─────────────────────────────────────────────────────────
  if (view === 'email-sent') {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
          <div className="text-5xl mb-4">📬</div>
          <h1 className="text-2xl font-bold mb-2 text-white">Check your email</h1>
          <p className="text-gray-400 mb-1">We sent a magic link to</p>
          <p className="text-white font-medium mb-6 break-all">{email}</p>

          <p className="text-sm text-gray-500 mb-6">
            Click the link in the email to sign in. The link expires in 15 minutes.
          </p>

          {emailError && (
            <div className="mb-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
              <p className="text-sm text-red-400">{emailError}</p>
            </div>
          )}

          <button
            onClick={handleResend}
            disabled={resendCooldown > 0 || emailLoading}
            className="w-full px-6 py-3 border border-gray-700 text-gray-300 rounded-lg hover:bg-gray-900 transition disabled:opacity-50 disabled:cursor-not-allowed mb-3"
          >
            {emailLoading
              ? 'Sending…'
              : resendCooldown > 0
                ? `Resend in ${resendCooldown}s`
                : 'Resend email'}
          </button>

          <button
            onClick={goBackToEmail}
            className="text-sm text-gray-500 hover:text-gray-300 transition"
          >
            ← Try a different email
          </button>
        </div>
      </div>
    );
  }

  // ── MFA stub view ───────────────────────────────────────────────────────────
  if (view === 'login-mfa') {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-2xl font-bold mb-2 text-white">Email verified</h1>
          <p className="text-gray-400 mb-6">
            Now import your key to complete login.
          </p>
          <button
            onClick={goBackToEmail}
            className="text-sm text-gray-500 hover:text-gray-300 transition"
          >
            ← Back to email
          </button>
        </div>
      </div>
    );
  }

  // ── Keypair view ────────────────────────────────────────────────────────────
  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <button
          onClick={goBackToEmail}
          className="text-sm text-gray-500 hover:text-gray-300 transition mb-4 flex items-center gap-1"
        >
          ← Back to email
        </button>

        <h1 className="text-2xl font-bold mb-2 text-center text-white">Login / Recovery</h1>
        <p className="text-gray-400 text-center mb-4">
          Import your private key to access your identity
        </p>

        {fromEmailForbidden && (
          <div className="mb-4 p-3 bg-amber-900/20 border border-amber-700/50 rounded-lg">
            <p className="text-sm text-amber-400">
              This identity uses key-based authentication. Please import your private key to continue.
            </p>
          </div>
        )}

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
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                  }}
                  className="hidden"
                  disabled={keypairLoading}
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
                onChange={e => setPrivateKeyHex(e.target.value)}
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
              disabled={keypairLoading || !privateKeyHex.trim()}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {keypairLoading ? 'Importing...' : 'Import & Login'}
            </button>
          </form>
        )}

        {/* Error display */}
        {keypairError && (
          <div className="mt-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
            <p className="text-sm text-red-400">{keypairError}</p>
          </div>
        )}

        {/* Loading state */}
        {keypairLoading && (
          <div className="mt-4 text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F59E0B]"></div>
            <p className="text-sm text-gray-400 mt-2">Importing keys...</p>
          </div>
        )}

        <div className="mt-6 p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <p className="text-sm text-gray-400">
            <strong className="text-white">Don&apos;t have an account?</strong>
            <br />
            <a href="/register" className="text-[#F59E0B] hover:underline mt-1 inline-block">
              Create a new identity →
            </a>
          </p>
        </div>

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
