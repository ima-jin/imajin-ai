/* eslint-disable no-console */
'use client';

import { useState, useEffect } from 'react';
import RecoveryCodesSection from './components/RecoveryCodesSection';
import StatusBanner, { type StatusMessage } from './components/StatusBanner';
import PasswordLoginSection from './components/PasswordLoginSection';
import TotpSection, { type TotpSetupData } from './components/TotpSection';
import EmailMfaSection from './components/EmailMfaSection';
import DevicesSection, { type Device } from './components/DevicesSection';

interface AccountMethods {
  did: string;
  hasStoredKey: boolean;
  mfaMethods: string[];
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
  const encryptedKey = btoa(String.fromCodePoint(...ivAndCipher));
  const salt = btoa(String.fromCodePoint(...saltBytes));
  return { encryptedKey, salt };
}

async function decryptStoredKey(encryptedKeyB64: string, saltB64: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), c => c.codePointAt(0)!);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const derivedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const combined = Uint8Array.from(atob(encryptedKeyB64), c => c.codePointAt(0)!);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derivedKey, ciphertext);
  return new TextDecoder().decode(decrypted);
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
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [actionLoading, setActionLoading] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const sessionRes = await fetch('/auth/api/session', { credentials: 'include' });
      if (!sessionRes.ok) {
        globalThis.location.href = '/auth/login?next=/auth/settings/security';
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

  // Change password: verify current password, then re-encrypt with new one
  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      showStatus('error', 'Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      showStatus('error', 'Password must be at least 8 characters.');
      return;
    }
    setActionLoading('password-change');
    try {
      // Fetch the current stored key to verify the old password
      const methodsRes = await fetch(`/auth/api/account/methods?did=${encodeURIComponent(methods?.did || '')}&includeKey=true`, {
        credentials: 'include',
      });
      if (!methodsRes.ok) {
        showStatus('error', 'Failed to fetch stored key.');
        return;
      }
      const methodsData = await methodsRes.json();
      if (!methodsData.encryptedKey || !methodsData.salt) {
        showStatus('error', 'No stored key found.');
        return;
      }

      // Verify current password by attempting decryption
      try {
        await decryptStoredKey(methodsData.encryptedKey, methodsData.salt, currentPassword);
      } catch {
        showStatus('error', 'Current password is incorrect.');
        return;
      }

      // Re-encrypt with new password using the key from localStorage
      const keypairJson = localStorage.getItem('imajin_keypair');
      if (!keypairJson) {
        showStatus('error', 'No key found in this browser.');
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
        setShowPasswordChange(false);
        setCurrentPassword('');
        setPassword('');
        setConfirmPassword('');
        showStatus('success', 'Password changed successfully.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to update password.');
      }
    } catch {
      showStatus('error', 'Failed to change password. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  // Reset password: re-encrypt from localStorage key without requiring current password
  async function handlePasswordReset(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      showStatus('error', 'Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      showStatus('error', 'Password must be at least 8 characters.');
      return;
    }
    setActionLoading('password-reset');
    try {
      const keypairJson = localStorage.getItem('imajin_keypair');
      if (!keypairJson) {
        showStatus('error', 'No key found in this browser. This device cannot reset the password.');
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
        setShowPasswordReset(false);
        setPassword('');
        setConfirmPassword('');
        showStatus('success', 'Password has been reset. Use your new password to log in on other devices.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to reset password.');
      }
    } catch {
      showStatus('error', 'Failed to reset password. Please try again.');
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
      const res = await fetch(`/auth/api/devices/${deviceId}/trust`, {
        method: 'POST',
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

  const hasTotpEnabled = !!methods?.mfaMethods.includes('totp');
  const hasEmailMfa = !!methods?.mfaMethods.includes('email');
  const hasMfa = (methods?.mfaMethods.length ?? 0) > 0;
  const hasStoredKey = !!methods?.hasStoredKey;

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

        <StatusBanner statusMessage={statusMessage} />

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

          <PasswordLoginSection
            hasStoredKey={hasStoredKey}
            hasMfa={hasMfa}
            showPasswordChange={showPasswordChange}
            showPasswordReset={showPasswordReset}
            showPasswordSetup={showPasswordSetup}
            currentPassword={currentPassword}
            password={password}
            confirmPassword={confirmPassword}
            actionLoading={actionLoading}
            onOpenChange={() => { setShowPasswordChange(true); setShowPasswordReset(false); setCurrentPassword(''); setPassword(''); setConfirmPassword(''); }}
            onOpenSetup={() => { setShowPasswordSetup(true); setPassword(''); setConfirmPassword(''); }}
            onSwitchToReset={() => { setShowPasswordChange(false); setShowPasswordReset(true); setCurrentPassword(''); setPassword(''); setConfirmPassword(''); }}
            onCancelChange={() => { setShowPasswordChange(false); setCurrentPassword(''); setPassword(''); setConfirmPassword(''); }}
            onCancelReset={() => { setShowPasswordReset(false); setPassword(''); setConfirmPassword(''); }}
            onCancelSetup={() => { setShowPasswordSetup(false); setPassword(''); setConfirmPassword(''); }}
            setCurrentPassword={setCurrentPassword}
            setPassword={setPassword}
            setConfirmPassword={setConfirmPassword}
            handlePasswordChange={handlePasswordChange}
            handlePasswordReset={handlePasswordReset}
            handlePasswordSetup={handlePasswordSetup}
          />
        </div>

        {/* Recovery codes */}
        <RecoveryCodesSection />

        {/* MFA methods */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-2">Multi-factor authentication</h2>
          <p className="text-sm text-gray-400 mb-6">Add a second factor to protect logins after key authentication.</p>

          <TotpSection
            hasTotpEnabled={hasTotpEnabled}
            showTotpSetup={showTotpSetup}
            totpSetup={totpSetup}
            totpCode={totpCode}
            showTotpDisable={showTotpDisable}
            totpDisableCode={totpDisableCode}
            actionLoading={actionLoading}
            onStartSetup={handleStartTotpSetup}
            onOpenDisable={() => setShowTotpDisable(true)}
            onCancelSetup={() => { setShowTotpSetup(false); setTotpSetup(null); }}
            onCancelDisable={() => { setShowTotpDisable(false); setTotpDisableCode(''); }}
            setTotpCode={setTotpCode}
            setTotpDisableCode={setTotpDisableCode}
            handleVerifyTotp={handleVerifyTotp}
            handleDisableTotp={handleDisableTotp}
          />

          <EmailMfaSection
            hasEmailMfa={hasEmailMfa}
            showEmailSetup={showEmailSetup}
            emailCode={emailCode}
            actionLoading={actionLoading}
            onStartSetup={handleStartEmailSetup}
            onDisable={handleDisableEmailMfa}
            onCancelSetup={() => { setShowEmailSetup(false); setEmailCode(''); }}
            setEmailCode={setEmailCode}
            handleVerifyEmailSetup={handleVerifyEmailSetup}
          />

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

        <DevicesSection
          devices={devices}
          actionLoading={actionLoading}
          onTrustDevice={handleTrustDevice}
          onRemoveDevice={handleRemoveDevice}
        />

      </div>
    </div>
  );
}
