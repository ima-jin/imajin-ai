'use client';

import { useState, FormEvent } from 'react';
import { SCOPES } from '@imajin/auth';

interface RegisteredApp {
  id: string;
  appDid: string;
  name: string;
  keypair?: { privateKey: string; publicKey: string };
}

interface Props {
  onSuccess: (app: RegisteredApp) => void;
  onCancel: () => void;
}

export default function RegisterAppForm({ onSuccess, onCancel }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [useOwnKey, setUseOwnKey] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  // Post-registration state
  const [createdApp, setCreatedApp] = useState<RegisteredApp | null>(null);
  const [keypairDownloaded, setKeypairDownloaded] = useState(false);

  function toggleScope(scope: string) {
    setSelectedScopes(prev =>
      prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('loading');
    setError('');

    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || undefined,
      callbackUrl: callbackUrl.trim(),
      homepageUrl: homepageUrl.trim() || undefined,
      logoUrl: logoUrl.trim() || undefined,
      requestedScopes: selectedScopes,
    };

    if (useOwnKey && publicKey.trim()) {
      payload.publicKey = publicKey.trim();
    }

    try {
      const res = await fetch('/api/registry/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus('error');
        setError(data.error || 'Registration failed');
        return;
      }

      // If server generated a keypair, show the download screen
      if (data.keypair) {
        setCreatedApp(data);
        setStatus('idle');
      } else {
        onSuccess(data);
      }
    } catch {
      setStatus('error');
      setError('Network error — please try again');
    }
  }

  function downloadKeypair() {
    if (!createdApp?.keypair) return;
    const blob = new Blob(
      [JSON.stringify({
        did: createdApp.appDid,
        publicKey: createdApp.keypair.publicKey,
        privateKey: createdApp.keypair.privateKey,
      }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `.app-${name.trim().toLowerCase().replace(/\s+/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setKeypairDownloaded(true);
  }

  // --- Post-registration: keypair download screen ---
  if (createdApp?.keypair) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-white mb-1">App Registered ✓</h2>
          <p className="text-sm text-zinc-400">
            <strong className="text-white">{createdApp.name}</strong> — <code className="text-xs text-amber-400">{createdApp.appDid}</code>
          </p>
        </div>

        <div className="bg-red-950/30 border border-red-800/40 rounded-lg p-4 space-y-3">
          <p className="text-sm text-red-300 font-medium">⚠️ Download your keypair now</p>
          <p className="text-xs text-red-400/80">
            This is the only time the private key will be shown. It is not stored on the server.
            If you lose it, you&apos;ll need to re-register the app.
          </p>
          <button
            onClick={downloadKeypair}
            className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors text-sm"
          >
            Download Keypair (.json)
          </button>
        </div>

        <div>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">App DID</p>
          <code className="block text-xs text-zinc-300 bg-zinc-800 rounded-lg p-3 font-mono break-all">
            {createdApp.appDid}
          </code>
        </div>

        <div className="flex gap-3 pt-1">
          <button
            onClick={() => onSuccess(createdApp)}
            disabled={!keypairDownloaded}
            className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-black font-semibold rounded-lg transition-colors text-sm"
          >
            {keypairDownloaded ? 'Done' : 'Download keypair first'}
          </button>
        </div>
      </div>
    );
  }

  // --- Registration form ---
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-white">Register New App</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          Cancel
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
            App Name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My Awesome App"
            required
            maxLength={100}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors text-sm"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
            Description <span className="text-zinc-600">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does your app do?"
            rows={2}
            maxLength={500}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors resize-none text-sm"
          />
        </div>

        {/* Callback URL */}
        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
            Callback URL <span className="text-red-400">*</span>
          </label>
          <input
            type="url"
            value={callbackUrl}
            onChange={e => setCallbackUrl(e.target.value)}
            placeholder="https://yourapp.com/auth/callback"
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors text-sm"
          />
          <p className="mt-1 text-xs text-zinc-600">Where users are redirected after granting consent</p>
        </div>

        {/* Homepage URL */}
        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
            Homepage URL <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="url"
            value={homepageUrl}
            onChange={e => setHomepageUrl(e.target.value)}
            placeholder="https://yourapp.com"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors text-sm"
          />
        </div>

        {/* Logo URL */}
        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
            Logo URL <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="url"
            value={logoUrl}
            onChange={e => setLogoUrl(e.target.value)}
            placeholder="https://yourapp.com/logo.png"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors text-sm"
          />
        </div>

        {/* Requested Scopes */}
        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Requested Scopes
          </label>
          <div className="space-y-1.5">
            {Object.entries(SCOPES).map(([scope, label]) => (
              <label key={scope} className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500 focus:ring-offset-zinc-900"
                />
                <span className="text-sm">
                  <span className="font-mono text-xs text-amber-400/80 mr-2">{scope}</span>
                  <span className="text-zinc-400">{label}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Keypair option */}
        <div className="border-t border-zinc-800 pt-4">
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Identity Keypair
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                checked={!useOwnKey}
                onChange={() => setUseOwnKey(false)}
                className="w-4 h-4 border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500 focus:ring-offset-zinc-900"
              />
              <span className="text-sm text-zinc-300">Generate keypair for me <span className="text-zinc-500">(recommended)</span></span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                checked={useOwnKey}
                onChange={() => setUseOwnKey(true)}
                className="w-4 h-4 border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500 focus:ring-offset-zinc-900"
              />
              <span className="text-sm text-zinc-300">I have my own Ed25519 public key</span>
            </label>
          </div>

          {useOwnKey && (
            <div className="mt-3">
              <textarea
                value={publicKey}
                onChange={e => setPublicKey(e.target.value)}
                placeholder="64-character hex Ed25519 public key"
                rows={2}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors resize-none text-sm font-mono"
              />
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2.5">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-600 transition-colors text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={status === 'loading' || !name.trim() || !callbackUrl.trim() || (useOwnKey && !publicKey.trim())}
            className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-amber-900/40 disabled:text-amber-700 text-black font-semibold rounded-lg transition-colors text-sm"
          >
            {status === 'loading' ? 'Registering…' : 'Register App'}
          </button>
        </div>
      </form>
    </div>
  );
}
