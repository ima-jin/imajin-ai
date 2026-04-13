'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

const CATEGORY_PRESETS = ['café', 'restaurant', 'shop', 'venue', 'studio', 'bar', 'gallery', 'gym'];

export default function NewStubPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [location, setLocation] = useState('');
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/profile/api/stubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          category: category.trim() || undefined,
          location: location.trim() || undefined,
          handle: handle.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create place');
        return;
      }

      // Redirect to the new stub's profile
      const dest = data.handle ? `/profile/${data.handle}` : `/profile/${data.did}`;
      router.push(dest);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto py-8">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-white mb-1">Add a Place</h1>
        <p className="text-zinc-400 text-sm mb-6">
          Create a community-maintained stub for a business that isn&apos;t on Imajin yet.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rosetta Café"
              maxLength={100}
              required
              className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Category
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {CATEGORY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setCategory(category === preset ? '' : preset)}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    category === preset
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                      : 'bg-zinc-900 border-gray-700 text-zinc-400 hover:border-gray-500'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="or type your own…"
              maxLength={100}
              className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          {/* Location */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Location
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. 123 Main St, Portland OR"
              maxLength={200}
              className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          {/* Handle */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Handle <span className="text-zinc-600">(optional)</span>
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="rosetta_cafe"
                maxLength={30}
                pattern="[a-z0-9_]{3,30}"
                className="w-full bg-zinc-900 border border-gray-700 rounded-lg pl-8 pr-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>
            <p className="mt-1 text-xs text-zinc-600">3–30 lowercase letters, numbers, or underscores</p>
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => router.back()}
              className="flex-1 px-4 py-2.5 bg-zinc-900 border border-gray-700 rounded-lg text-zinc-400 hover:text-white hover:border-gray-500 transition-colors text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-amber-900/40 disabled:text-amber-700 text-black font-semibold rounded-lg transition-colors text-sm"
            >
              {submitting ? 'Creating…' : 'Add Place'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
