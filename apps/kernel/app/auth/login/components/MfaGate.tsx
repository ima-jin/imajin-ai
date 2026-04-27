'use client';

import { useState, useRef, useEffect } from 'react';

interface MfaGateProps {
  methods: string[];
  challengeToken: string;
  did: string;
  nextUrl: string | null;
  onSuccess: (did: string) => void;
  onCancel: () => void;
}

export default function MfaGate({ methods, challengeToken, did, nextUrl, onSuccess, onCancel }: MfaGateProps) {
  const [selectedMethod, setSelectedMethod] = useState<string>(methods[0] || 'totp');
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    codeInputRef.current?.focus();
  }, [selectedMethod]);

  async function handleSendEmailCode() {
    setEmailSending(true);
    setError('');
    try {
      const res = await fetch('/auth/api/mfa/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken }),
      });
      if (res.ok) {
        setEmailSent(true);
        setTimeout(() => codeInputRef.current?.focus(), 100);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Failed to send code');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setEmailSending(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/auth/api/login/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, method: selectedMethod, code, trustDevice }),
      });

      if (res.ok) {
        const data = await res.json();
        const resolvedDid = data.did || did;
        localStorage.setItem('imajin_did', resolvedDid);
        onSuccess(resolvedDid);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Invalid code. Please try again.');
        setCode('');
        codeInputRef.current?.focus();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleCodeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(val);
    // Auto-submit on 6th digit
    if (val.length === 6) {
      // Small delay to let state settle
      setTimeout(() => {
        document.getElementById('mfa-submit-btn')?.click();
      }, 50);
    }
  }

  const methodLabel = (m: string) => {
    if (m === 'totp') return 'Authenticator App';
    if (m === 'email') return 'Email Code';
    return m;
  };

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-white/10 p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-primary font-mono">Verify your identity</h1>
        <p className="text-secondary text-center mb-6 text-sm">Complete one verification method to continue</p>

        {/* Method selector (only if multiple methods) */}
        {methods.length > 1 && (
          <div className="flex gap-2 mb-6">
            {methods.map(m => (
              <button
                key={m}
                onClick={() => { setSelectedMethod(m); setCode(''); setError(''); setEmailSent(false); }}
                className={`flex-1 px-3 py-2 text-sm transition ${selectedMethod === m ? 'bg-[#F59E0B] text-black font-medium' : 'bg-surface-surface text-secondary hover:bg-surface-elevated'}`}
              >
                {methodLabel(m)}
              </button>
            ))}
          </div>
        )}

        {/* Email: send code first */}
        {selectedMethod === 'email' && !emailSent && (
          <div className="mb-6">
            <p className="text-sm text-secondary mb-4">
              We&apos;ll send a 6-digit code to your registered email address.
            </p>
            <button
              onClick={handleSendEmailCode}
              disabled={emailSending}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {emailSending ? 'Sending…' : 'Send code to email'}
            </button>
          </div>
        )}

        {/* TOTP or after email sent */}
        {(selectedMethod === 'totp' || (selectedMethod === 'email' && emailSent)) && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {selectedMethod === 'email' && emailSent && (
              <div className="p-3 bg-success/20 border border-green-800 mb-4">
                <p className="text-sm text-success">Code sent! Check your email.</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2 text-primary">
                {selectedMethod === 'totp' ? 'Enter 6-digit code from your authenticator app' : 'Enter the 6-digit code from your email'}
              </label>
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                value={code}
                onChange={handleCodeChange}
                placeholder="000000"
                maxLength={6}
                required
                className="w-full px-4 py-3 border border-white/10 bg-surface-base text-primary text-center text-2xl font-mono tracking-widest focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
              />
            </div>

            {error && (
              <div className="p-3 bg-error/20 border border-red-800">
                <p className="text-sm text-error">{error}</p>
              </div>
            )}

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={trustDevice}
                onChange={e => setTrustDevice(e.target.checked)}
                className="w-4 h-4 accent-[#F59E0B]"
              />
              <span className="text-sm text-secondary">Trust this device for 30 days</span>
            </label>

            <button
              id="mfa-submit-btn"
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        )}

        {error && selectedMethod === 'email' && !emailSent && (
          <div className="mt-4 p-3 bg-error/20 border border-red-800">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        <button
          onClick={onCancel}
          className="mt-4 w-full text-sm text-secondary hover:text-primary transition"
        >
          ← Back to sign in
        </button>
      </div>
    </div>
  );
}
