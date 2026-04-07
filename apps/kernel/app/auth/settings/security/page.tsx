'use client';

import { useState, useEffect } from 'react';

interface AccountMethods {
  did: string;
  hasStoredKey: boolean;
  mfaMethods: string[];
}

interface TotpSetupData {
  secret: string;
  otpauthUrl: string;
  qrCode: string;
}

interface Device {
  id: string;
  fingerprint: string;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
  trusted: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

function truncateUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (ua.length <= 60) return ua;
  return ua.slice(0, 57) + '…';
}

async function encryptPrivateKey(privateKeyJson: string, password: string): Promise<{ encryptedKey: string; salt: string }> {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    enc.encode(privateKeyJson)
  );
  // Encode iv + ciphertext as base64 for encryptedKey, salt separately
  const ivAndCipher = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  ivAndCipher.set(iv, 0);
  ivAndCipher.set(new Uint8Array(ciphertext), iv.byteLength);
  const encryptedKey = btoa(String.fromCharCode(...ivAndCipher));
  const salt = btoa(String.fromCharCode(...saltBytes));
  return { encryptedKey, salt };
}

export default function SecuritySettingsPage() {
  const [loading, setLoading] = useState(true);
  const [methods, setMethods] = useState<AccountMethods | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [totpSetup, setTotpSetup] = useState<TotpSetupData | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpDisableCode, setTotpDisableCode] = useState('');
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const [showTotpDisable, setShowTotpDisable] = useState(false);
  const [showEmailSetup, setShowEmailSetup] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [showPasswordSetup, setShowPasswordSetup] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const sessionRes = await fetch('/auth/api/session', { credentials: 'include' });
      if (!sessionRes.ok) {
        window.location.href = '/login?next=/settings/security';
        return;
      }
      const session = await sessionRes.json();

      const methodsRes = await fetch(`/auth/api/account/methods?did=${encodeURIComponent(session.did)}`);
      if (methodsRes.ok) {
        setMethods(await methodsRes.json());
      }

      const devicesRes = await fetch('/auth/api/devices', { credentials: 'include' });
      if (devicesRes.ok) {
        const data = await devicesRes.json();
        setDevices(data.devices || []);
      }
    } catch (err) {
      console.error('Failed to load security settings:', err);
    } finally {
      setLoading(false);
    }
  }

  function showStatus(type: 'success' | 'error', text: string) {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 5000);
  }

  // TOTP setup
  async function handleStartTotpSetup() {
    setActionLoading('totp-setup');
    try {
      const res = await fetch('/auth/api/mfa/totp/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setTotpSetup(data);
        setShowTotpSetup(true);
        setTotpCode('');
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to start TOTP setup');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleVerifyTotp(e: React.FormEvent) {
    e.preventDefault();
    setActionLoading('totp-verify');
    try {
      const res = await fetch('/auth/api/mfa/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
        credentials: 'include',
      });
      if (res.ok) {
        setShowTotpSetup(false);
        setTotpSetup(null);
        setTotpCode('');
        showStatus('success', 'Authenticator app enabled successfully.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Invalid code. Please try again.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleDisableTotp(e: React.FormEvent) {
    e.preventDefault();
    setActionLoading('totp-disable');
    try {
      const res = await fetch('/auth/api/mfa/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpDisableCode }),
        credentials: 'include',
      });
      if (res.ok) {
        setShowTotpDisable(false);
        setTotpDisableCode('');
        showStatus('success', 'Authenticator app removed.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Invalid code. Please try again.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  // Email MFA setup
  async function handleStartEmailSetup() {
    setActionLoading('email-setup');
    try {
      const res = await fetch('/auth/api/mfa/email/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include',
      });
      if (res.ok) {
        setShowEmailSetup(true);
        setEmailCode('');
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to send email code');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleVerifyEmailSetup(e: React.FormEvent) {
    e.preventDefault();
    setActionLoading('email-verify');
    try {
      const res = await fetch('/auth/api/mfa/email/verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: emailCode }),
        credentials: 'include',
      });
      if (res.ok) {
        setShowEmailSetup(false);
        setEmailCode('');
        showStatus('success', 'Email MFA enabled successfully.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Invalid code. Please try again.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleDisableEmailMfa() {
    setActionLoading('email-disable');
    try {
      const res = await fetch('/auth/api/mfa/email/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include',
      });
      if (res.ok) {
        showStatus('success', 'Email MFA disabled.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to disable email MFA');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  // Password (stored key) setup
  async function handlePasswordSetup(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      showStatus('error', 'Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      showStatus('error', 'Password must be at least 8 characters.');
      return;
    }
    setActionLoading('password-setup');
    try {
      const keypairJson = localStorage.getItem('imajin_keypair');
      if (!keypairJson) {
        showStatus('error', 'No key found in this browser. Sign in with your key first.');
        return;
      }
      const { encryptedKey, salt } = await encryptPrivateKey(keypairJson, password);
      const res = await fetch('/auth/api/stored-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedKey, salt, keyDerivation: 'pbkdf2' }),
        credentials: 'include',
      });
      if (res.ok) {
        setShowPasswordSetup(false);
        setPassword('');
        setConfirmPassword('');
        showStatus('success', 'Password login enabled. You can now log in with your password.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to set up password login');
      }
    } catch {
      showStatus('error', 'Failed to encrypt key. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleRemoveDevice(deviceId: string) {
    setActionLoading(`device-${deviceId}`);
    try {
      const res = await fetch(`/auth/api/devices/${deviceId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setDevices(prev => prev.filter(d => d.id !== deviceId));
        showStatus('success', 'Device removed.');
      } else {
        showStatus('error', 'Failed to remove device.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleTrustDevice(deviceId: string) {
    setActionLoading(`trust-${deviceId}`);
    try {
      const res = await fetch(`/auth/api/devices/trust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
        credentials: 'include',
      });
      if (res.ok) {
        setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, trusted: true } : d));
        showStatus('success', 'Device trusted.');
      } else {
        showStatus('error', 'Failed to trust device.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  const hasTotpEnabled = methods?.mfaMethods.includes('totp');
  const hasEmailMfa = methods?.mfaMethods.includes('email');
  const hasMfa = (methods?.mfaMethods.length ?? 0) > 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-center text-gray-400">Loading security settings…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-8">

        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Security settings</h1>
          <p className="text-gray-400 text-sm">Manage how you authenticate and protect your account.</p>
        </div>

        {/* Status message */}
        {statusMessage && (
          <div className={`p-4 rounded-lg border ${statusMessage.type === 'success' ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-red-900/20 border-red-800 text-red-400'}`}>
            {statusMessage.text}
          </div>
        )}

        {/* Auth methods */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-6">Authentication methods</h2>

          {/* Key */}
          <div className="flex items-start justify-between py-4 border-b border-gray-800">
            <div>
              <p className="text-white font-medium">Cryptographic key</p>
              <p className="text-sm text-gray-400 mt-1">Always on — your sovereign identity. Your key is the root of all auth.</p>
            </div>
            <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap ml-4">Always active</span>
          </div>

          {/* Stored key (password login) */}
          <div className="py-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-white font-medium">Password login</p>
                <p className="text-sm text-gray-400 mt-1">
                  {methods?.hasStoredKey
                    ? 'Your encrypted key is stored. Use your password to log in on this device.'
                    : 'Store an encrypted copy of your key to log in with a password.'}
                </p>
                {methods?.hasStoredKey && !hasMfa && (
                  <p className="text-xs text-blue-400 mt-2">We recommend setting up an additional MFA method (authenticator app or email code) to protect your account.</p>
                )}
              </div>
              <div className="ml-4 flex flex-col items-end gap-2">
                {methods?.hasStoredKey ? (
                  <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Active</span>
                ) : (
                  <>
                    <span className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 whitespace-nowrap">Not set up</span>
                    <button
                      onClick={() => { setShowPasswordSetup(true); setPassword(''); setConfirmPassword(''); }}
                      className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition"
                    >
                      Set up password
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Password setup flow */}
            {showPasswordSetup && !methods?.hasStoredKey && (
              <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
                <h3 className="text-white font-medium mb-2">Set up password login</h3>
                <p className="text-sm text-gray-400 mb-4">
                  Your private key will be encrypted in your browser using this password and stored securely.
                  Choose a strong password — it cannot be recovered if lost.
                </p>
                <form onSubmit={handlePasswordSetup} className="space-y-3">
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="New password"
                    autoFocus
                    className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                  />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="Confirm password"
                    className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                  />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={!password || !confirmPassword || actionLoading === 'password-setup'}
                      className="flex-1 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
                    >
                      {actionLoading === 'password-setup' ? 'Encrypting…' : 'Enable password login'}
                    </button>
                  </div>
                </form>
                <button
                  onClick={() => { setShowPasswordSetup(false); setPassword(''); setConfirmPassword(''); }}
                  className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* MFA methods */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-2">Multi-factor authentication</h2>
          <p className="text-sm text-gray-400 mb-6">Add a second factor to protect logins after key authentication.</p>

          {/* TOTP */}
          <div className="py-4 border-b border-gray-800">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-white font-medium">Authenticator app (TOTP)</p>
                <p className="text-sm text-gray-400 mt-1">Use an app like Authy or Google Authenticator to generate codes.</p>
              </div>
              <div className="ml-4 flex flex-col items-end gap-2">
                {hasTotpEnabled ? (
                  <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Active</span>
                ) : (
                  <span className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 whitespace-nowrap">Not set up</span>
                )}
                {hasTotpEnabled ? (
                  <button
                    onClick={() => setShowTotpDisable(true)}
                    className="text-sm px-3 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    onClick={handleStartTotpSetup}
                    disabled={actionLoading === 'totp-setup'}
                    className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition disabled:opacity-50"
                  >
                    {actionLoading === 'totp-setup' ? 'Setting up…' : 'Set up'}
                  </button>
                )}
              </div>
            </div>

            {/* TOTP setup flow */}
            {showTotpSetup && totpSetup && (
              <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
                <h3 className="text-white font-medium mb-3">Scan QR code</h3>
                <p className="text-sm text-gray-400 mb-4">Scan this code with your authenticator app, then enter the 6-digit code to confirm.</p>
                <div className="flex justify-center mb-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={totpSetup.qrCode} alt="TOTP QR Code" className="rounded" width={200} height={200} />
                </div>
                <p className="text-xs text-gray-500 text-center mb-4 font-mono break-all">
                  Manual key: {totpSetup.secret}
                </p>
                <form onSubmit={handleVerifyTotp} className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={totpCode}
                    onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    className="flex-1 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white text-center font-mono tracking-widest focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                  />
                  <button
                    type="submit"
                    disabled={totpCode.length !== 6 || actionLoading === 'totp-verify'}
                    className="px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
                  >
                    {actionLoading === 'totp-verify' ? 'Verifying…' : 'Confirm'}
                  </button>
                </form>
                <button
                  onClick={() => { setShowTotpSetup(false); setTotpSetup(null); }}
                  className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* TOTP disable flow */}
            {showTotpDisable && (
              <div className="mt-4 p-4 bg-red-900/10 border border-red-800/50 rounded-lg">
                <h3 className="text-white font-medium mb-2">Confirm removal</h3>
                <p className="text-sm text-gray-400 mb-4">Enter your current authenticator code to remove TOTP.</p>
                <form onSubmit={handleDisableTotp} className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={totpDisableCode}
                    onChange={e => setTotpDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    className="flex-1 px-4 py-2 border border-red-800 rounded-lg bg-black text-white text-center font-mono tracking-widest focus:ring-2 focus:ring-red-600 focus:border-transparent"
                  />
                  <button
                    type="submit"
                    disabled={totpDisableCode.length !== 6 || actionLoading === 'totp-disable'}
                    className="px-4 py-2 border border-red-700 text-red-400 rounded-lg hover:bg-red-900/30 transition disabled:opacity-50"
                  >
                    {actionLoading === 'totp-disable' ? 'Removing…' : 'Remove'}
                  </button>
                </form>
                <button
                  onClick={() => { setShowTotpDisable(false); setTotpDisableCode(''); }}
                  className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Email MFA */}
          <div className="py-4 border-b border-gray-800">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-white font-medium">Email code</p>
                <p className="text-sm text-gray-400 mt-1">Receive a one-time code via email as a second factor.</p>
              </div>
              <div className="ml-4 flex flex-col items-end gap-2">
                {hasEmailMfa ? (
                  <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Active</span>
                ) : (
                  <span className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 whitespace-nowrap">Not set up</span>
                )}
                {hasEmailMfa ? (
                  <button
                    onClick={handleDisableEmailMfa}
                    disabled={actionLoading === 'email-disable'}
                    className="text-sm px-3 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition disabled:opacity-50"
                  >
                    {actionLoading === 'email-disable' ? 'Disabling…' : 'Disable'}
                  </button>
                ) : (
                  <button
                    onClick={handleStartEmailSetup}
                    disabled={actionLoading === 'email-setup'}
                    className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition disabled:opacity-50"
                  >
                    {actionLoading === 'email-setup' ? 'Sending…' : 'Enable'}
                  </button>
                )}
              </div>
            </div>

            {/* Email MFA setup flow */}
            {showEmailSetup && !hasEmailMfa && (
              <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
                <h3 className="text-white font-medium mb-2">Verify your email</h3>
                <p className="text-sm text-gray-400 mb-4">A 6-digit code was sent to your registered email address. Enter it below to activate email MFA.</p>
                <form onSubmit={handleVerifyEmailSetup} className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={emailCode}
                    onChange={e => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    className="flex-1 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white text-center font-mono tracking-widest focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                  />
                  <button
                    type="submit"
                    disabled={emailCode.length !== 6 || actionLoading === 'email-verify'}
                    className="px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
                  >
                    {actionLoading === 'email-verify' ? 'Verifying…' : 'Confirm'}
                  </button>
                </form>
                <button
                  onClick={() => { setShowEmailSetup(false); setEmailCode(''); }}
                  className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* SMS */}
          <div className="py-4 opacity-50">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-white font-medium">SMS</p>
                <p className="text-sm text-gray-400 mt-1">Receive a code via text message.</p>
              </div>
              <span className="ml-4 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-500 whitespace-nowrap">Coming soon</span>
            </div>
          </div>
        </div>

        {/* Session duration */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-2">Session duration</h2>
          <p className="text-sm text-gray-400 mb-4">How long you stay logged in on this device after signing in.</p>
          <select defaultValue="7d" className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent">
            <option value="1d">1 day</option>
            <option value="7d">7 days</option>
            <option value="28d">28 days</option>
            <option value="180d">6 months</option>
          </select>
          <p className="text-xs text-gray-600 mt-2">Applied when session cookie is set on this device.</p>
        </div>

        {/* Trusted devices */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-2">Known devices</h2>
          <p className="text-sm text-gray-400 mb-6">Devices that have been used to access your account.</p>

          {devices.length === 0 ? (
            <p className="text-sm text-gray-500">No devices recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {devices.map(device => (
                <div key={device.id} className="flex items-start justify-between p-3 bg-gray-900 rounded-lg border border-gray-800">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-white truncate">{truncateUserAgent(device.userAgent)}</p>
                      {device.trusted && (
                        <span className="px-1.5 py-0.5 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Trusted</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {device.ip && <span>{device.ip} · </span>}
                      Last seen {new Date(device.lastSeenAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2 ml-3 flex-shrink-0">
                    {!device.trusted && (
                      <button
                        onClick={() => handleTrustDevice(device.id)}
                        disabled={actionLoading === `trust-${device.id}`}
                        className="text-xs px-2 py-1 border border-gray-700 text-gray-400 rounded hover:bg-gray-800 transition disabled:opacity-50"
                      >
                        Trust
                      </button>
                    )}
                    <button
                      onClick={() => handleRemoveDevice(device.id)}
                      disabled={actionLoading === `device-${device.id}`}
                      className="text-xs px-2 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
