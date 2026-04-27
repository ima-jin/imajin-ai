'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CreateList() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleNameChange(v: string) {
    setName(v);
    setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await fetch('/api/admin/subscribers/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug, description: description || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to create list');
        return;
      }
      setOpen(false);
      setName('');
      setSlug('');
      setDescription('');
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-3 py-1.5 text-sm font-medium"
      >
        + Create List
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-base/50">
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-primary mb-4 font-mono">Create Mailing List</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-primary mb-1">Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Weekly Updates"
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-surface text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-primary mb-1">Slug</label>
            <input
              type="text"
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="weekly-updates"
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-surface text-gray-900 dark:text-primary px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-imajin-purple"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-primary mb-1">
              Description <span className="text-secondary">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What this list is for…"
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-surface text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple resize-none"
            />
          </div>
          {error && <p className="text-sm text-error dark:text-error">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create List'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
