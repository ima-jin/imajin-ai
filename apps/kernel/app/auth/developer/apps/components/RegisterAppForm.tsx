'use client';

import { useState, FormEvent } from 'react';
import { SCOPES } from '@imajin/auth';

interface RegisteredApp {
  id: string;
  appDid: string;
  name: string;
}

interface Props {
  onSuccess: (app: RegisteredApp) => void;
  onCancel: () => void;
}

const NODE_ONELINER = `node -e "const{generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('ed25519');console.log('Public:',publicKey.export({type:'spki',format:'der'}).toString('hex').slice(-64));console.log('Private:',privateKey.export({type:'pkcs8',format:'der'}).toString('hex').slice(-64))"`;

const NOBLE_ONELINER = `npx -y tsx -e "import{etc,getPublicKey}from'@noble/ed25519';const priv=etc.randomPrivateKey();console.log('Private:',Buffer.from(priv).toString('hex'));import{sha512}from'@noble/hashes/sha2.js';etc.sha512Sync=(...m)=>sha512(etc.concatBytes(...m));console.log('Public:',Buffer.from(getPublicKey(priv)).toString('hex'))"`;

export default function RegisterAppForm({ onSuccess, onCancel }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [showKeypairHelp, setShowKeypairHelp] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  function toggleScope(scope: string) {
    setSelectedScopes(prev =>
      prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('loading');
    setError('');

    try {
      const res = await fetch('/api/registry/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          callbackUrl: callbackUrl.trim(),
          homepageUrl: homepageUrl.trim() || undefined,
          logoUrl: logoUrl.trim() || undefined,
          publicKey: publicKey.trim(),
          requestedScopes: selectedScopes,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus('error');
        setError(data.error || 'Registration failed');
        return;
      }

      onSuccess(data);
    } catch {
      setStatus('error');
      setError('Network error — please try again');
    }
  }

  return (
    <div className="bg-surface-base border border-white/10 p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-primary font-mono">Register New App</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted hover:text-zinc-300 text-sm transition-colors"
        >
          Cancel
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
            App Name <span className="text-error">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My Awesome App"
            required
            maxLength={100}
            className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
            Description <span className="text-muted">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does your app do?"
            rows={2}
            maxLength={500}
            className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors resize-none text-sm"
          />
        </div>

        {/* Callback URL */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
            Callback URL <span className="text-error">*</span>
          </label>
          <input
            type="url"
            value={callbackUrl}
            onChange={e => setCallbackUrl(e.target.value)}
            placeholder="https://yourapp.com/auth/callback"
            required
            className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
          />
          <p className="mt-1 text-xs text-muted">Where users are redirected after granting consent</p>
        </div>

        {/* Homepage URL */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
            Homepage URL <span className="text-muted">(optional)</span>
          </label>
          <input
            type="url"
            value={homepageUrl}
            onChange={e => setHomepageUrl(e.target.value)}
            placeholder="https://yourapp.com"
            className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
          />
        </div>

        {/* Logo URL */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
            Logo URL <span className="text-muted">(optional)</span>
          </label>
          <input
            type="url"
            value={logoUrl}
            onChange={e => setLogoUrl(e.target.value)}
            placeholder="https://yourapp.com/logo.png"
            className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
          />
        </div>

        {/* Requested Scopes */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-2">
            Requested Scopes
          </label>
          <div className="space-y-1.5">
            {Object.entries(SCOPES).map(([scope, label]) => (
              <label key={scope} className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  className="w-4 h-4 border-white/10 bg-surface-elevated text-warning focus:ring-amber-500 focus:ring-offset-zinc-900"
                />
                <span className="text-sm">
                  <span className="font-mono text-xs text-warning/80 mr-2">{scope}</span>
                  <span className="text-secondary">{label}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Public Key */}
        <div>
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
            Public Key <span className="text-error">*</span>
          </label>
          <textarea
            value={publicKey}
            onChange={e => setPublicKey(e.target.value)}
            placeholder="64-character hex Ed25519 public key"
            rows={2}
            required
            className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors resize-none text-sm font-mono"
          />
          <p className="mt-1 text-xs text-muted">
            Generate an Ed25519 keypair and paste your public key (hex, 64 chars). Your private key stays with you.
          </p>

          {/* Keypair help */}
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowKeypairHelp(!showKeypairHelp)}
              className="text-xs text-warning/70 hover:text-warning transition-colors flex items-center gap-1"
            >
              <span>{showKeypairHelp ? '▼' : '▶'}</span>
              How to generate a keypair
            </button>

            {showKeypairHelp && (
              <div className="mt-2 space-y-3 p-3 bg-surface-elevated/50 border border-white/10/50">
                <div>
                  <p className="text-xs text-secondary mb-1.5 font-medium">Option 1 — Node.js built-in:</p>
                  <div className="relative">
                    <pre className="text-[10px] text-zinc-300 font-mono bg-surface-base p-2 overflow-x-auto whitespace-pre-wrap break-all">{NODE_ONELINER}</pre>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-secondary mb-1.5 font-medium">Option 2 — @noble/ed25519:</p>
                  <div className="relative">
                    <pre className="text-[10px] text-zinc-300 font-mono bg-surface-base p-2 overflow-x-auto whitespace-pre-wrap break-all">{NOBLE_ONELINER}</pre>
                  </div>
                </div>
                <p className="text-[10px] text-muted">
                  Save the private key securely — you will need it to sign requests. Never share it.
                </p>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="text-sm text-error bg-error/20 border border-red-800/40 px-3 py-2.5">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 bg-surface-elevated border border-white/10 text-secondary hover:text-primary hover:border-white/10 transition-colors text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={status === 'loading' || !name.trim() || !callbackUrl.trim() || !publicKey.trim()}
            className="flex-1 px-4 py-2.5 bg-warning hover:bg-warning disabled:bg-warning/20 disabled:text-warning text-black font-semibold transition-colors text-sm"
          >
            {status === 'loading' ? 'Registering…' : 'Register App'}
          </button>
        </div>
      </form>
    </div>
  );
}
