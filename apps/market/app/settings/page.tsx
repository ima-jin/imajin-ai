'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { apiFetch } from '@imajin/config';

export default function SettingsPage() {
  const [showMarketItems, setShowMarketItems] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const authUrl = `${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}auth.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}`;

  useEffect(() => {
    apiFetch('/api/seller/settings', { credentials: 'include' })
      .then(async (res) => {
        if (res.status === 401) {
          window.location.href = `${authUrl}/login?next=${encodeURIComponent(window.location.href)}`;
          return;
        }
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        setShowMarketItems(data.showMarketItems);
      })
      .catch(() => setError('Could not load settings. Please try again.'))
      .finally(() => setLoading(false));
  }, [authUrl]);

  async function handleToggle(value: boolean) {
    setShowMarketItems(value);
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/seller/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ showMarketItems: value }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setToast('Settings saved');
      setTimeout(() => setToast(''), 2500);
    } catch {
      setError('Failed to save settings. Please try again.');
      setShowMarketItems(!value); // revert
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/dashboard"
            className="text-gray-400 hover:text-gray-200 transition"
            aria-label="Back to dashboard"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-gray-400 text-sm mt-0.5">Manage your marketplace preferences</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 bg-red-900/30 border border-red-800 rounded-xl text-sm text-red-400 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-500 hover:text-red-300 transition">×</button>
          </div>
        )}

        {/* Settings Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
          <div className="p-5">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">Profile Integration</h2>

            {loading ? (
              <div className="flex items-center gap-4 animate-pulse">
                <div className="flex-1">
                  <div className="h-4 bg-gray-800 rounded w-1/2 mb-2" />
                  <div className="h-3 bg-gray-800 rounded w-3/4" />
                </div>
                <div className="w-11 h-6 bg-gray-800 rounded-full" />
              </div>
            ) : (
              <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
                <div>
                  <p className="text-sm font-medium text-gray-100">Show listings on my profile</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Display your active listings in the &ldquo;For Sale&rdquo; section of your public profile page.
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={showMarketItems}
                  disabled={saving}
                  onClick={() => handleToggle(!showMarketItems)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-50 ${
                    showMarketItems ? 'bg-orange-500' : 'bg-gray-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                      showMarketItems ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            )}
          </div>
        </div>

        {/* Toast */}
        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm text-green-400 shadow-xl flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
