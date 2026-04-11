'use client';

import { useState } from 'react';

const SCOPES = [
  { value: 'community', label: 'Community', icon: '🏛️', desc: 'A public or semi-public group' },
  { value: 'org', label: 'Organization', icon: '🏢', desc: 'A business or project' },
  { value: 'family', label: 'Family', icon: '👨‍👩‍👦', desc: 'A private family group' },
] as const;

export default function NewGroupPage() {
  const [scope, setScope] = useState<string>('community');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setStatus('loading');
    setError('');

    try {
      const res = await fetch('/auth/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          scope,
          name: name.trim(),
          handle: handle.trim() || undefined,
          description: description.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus('error');
        setError(data.error || 'Something went wrong');
        return;
      }

      // Redirect to the new group's settings
      window.location.href = `/auth/groups/${encodeURIComponent(data.did)}/settings`;
    } catch {
      setStatus('error');
      setError('Failed to create identity');
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-4 md:p-8">
      <div className="max-w-lg mx-auto space-y-6">

        <div>
          <a href="/auth/groups" className="text-sm text-gray-500 hover:text-gray-300 transition">
            ← Back to identities
          </a>
          <h1 className="text-2xl font-bold text-white mt-2 mb-1">Create Identity</h1>
          <p className="text-sm text-gray-400">Create a new group identity.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Scope picker */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Type</label>
            <div className="grid grid-cols-3 gap-2">
              {SCOPES.map(s => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setScope(s.value)}
                  className={`p-3 rounded-xl border text-center transition ${
                    scope === s.value
                      ? 'border-amber-500 bg-amber-500/10'
                      : 'border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <span className="text-xl">{s.icon}</span>
                  <p className={`text-sm font-medium mt-1 ${scope === s.value ? 'text-amber-400' : 'text-gray-300'}`}>
                    {s.label}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium text-gray-300">Name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Display name of group, collective, business"
              required
              maxLength={100}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/60"
            />
          </div>

          {/* Handle */}
          <div className="space-y-1.5">
            <label htmlFor="handle" className="text-sm font-medium text-gray-300">
              Handle <span className="text-gray-600">(optional)</span>
            </label>
            <div className="flex items-center gap-1">
              <span className="text-gray-500 text-sm">@</span>
              <input
                id="handle"
                type="text"
                value={handle}
                onChange={e => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="handle"
                maxLength={30}
                className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/60"
              />
            </div>
            <p className="text-xs text-gray-600">3-30 characters, lowercase letters, numbers, underscores</p>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label htmlFor="description" className="text-sm font-medium text-gray-300">
              Description <span className="text-gray-600">(optional)</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe this identity"
              rows={3}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/60 resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={status === 'loading' || !name.trim()}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-gray-950 font-semibold rounded-lg transition-colors"
          >
            {status === 'loading' ? 'Creating…' : 'Create Identity'}
          </button>
        </form>

      </div>
    </div>
  );
}
