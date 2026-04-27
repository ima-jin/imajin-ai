'use client';

import { useEffect, useState } from 'react';

interface Preference {
  id: string;
  did: string;
  scope: string;
  email: boolean;
  inapp: boolean;
}

const SCOPE_GROUPS = [
  {
    label: 'Market',
    scopes: [
      { scope: 'market:sale', label: 'Listing sold' },
      { scope: 'market:purchase', label: 'Purchase confirmed' },
    ],
  },
  {
    label: 'Events',
    scopes: [
      { scope: 'event:ticket', label: 'Ticket confirmed' },
      { scope: 'event:registration', label: 'Registration complete' },
    ],
  },
  {
    label: 'Coffee',
    scopes: [
      { scope: 'coffee:tip', label: 'Tip received' },
      { scope: 'coffee:tip-sent', label: 'Tip sent' },
    ],
  },
  {
    label: 'Chat',
    scopes: [
      { scope: 'chat:mention', label: 'Mentioned in conversation' },
    ],
  },
  {
    label: 'Connections',
    scopes: [
      { scope: 'connection:invite-accepted', label: 'Invitation accepted' },
    ],
  },
];

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'https://dev-auth.imajin.ai';

export default function SettingsPage() {
  const [prefs, setPrefs] = useState<Record<string, Preference>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);

  // Check session first
  useEffect(() => {
    fetch(`${AUTH_URL}/api/session`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) {
          window.location.href = `${AUTH_URL}/login?next=${encodeURIComponent(window.location.href)}`;
          return;
        }
        setAuthed(true);
      })
      .catch(() => {
        window.location.href = `${AUTH_URL}/login?next=${encodeURIComponent(window.location.href)}`;
      });
  }, []);

  // Load preferences after auth confirmed
  useEffect(() => {
    if (!authed) return;
    fetch('/notify/api/preferences', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, Preference> = {};
        for (const p of data.preferences ?? []) {
          map[p.scope] = p;
        }
        setPrefs(map);
      })
      .catch(() => setError('Failed to load preferences'))
      .finally(() => setLoading(false));
  }, [authed]);

  async function toggle(scope: string, channel: 'email' | 'inapp', value: boolean) {
    setSaving(`${scope}:${channel}`);
    try {
      const res = await fetch(`/notify/api/preferences/${encodeURIComponent(scope)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ [channel]: value }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      setPrefs((prev) => ({ ...prev, [scope]: data.preference }));
    } catch {
      setError('Failed to save preference');
    } finally {
      setSaving(null);
    }
  }

  function getPref(scope: string): { email: boolean; inapp: boolean } {
    return prefs[scope] ?? { email: true, inapp: true };
  }

  if (!authed || loading) {
    return (
      <div className="max-w-2xl mx-auto py-8">
        <p className="text-secondary">{!authed ? 'Checking session...' : 'Loading preferences...'}</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8">
      <h1 className="text-2xl font-bold text-primary mb-2 font-mono">Notification Settings</h1>
      <p className="text-secondary mb-8">Choose how you want to be notified for each event type.</p>

      {error && (
        <div className="mb-6 p-3 bg-red-950 border border-red-800 text-error text-sm">
          {error}
        </div>
      )}

      <div className="space-y-8">
        {SCOPE_GROUPS.map((group) => (
          <div key={group.label}>
            <h2 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-3 font-mono">
              {group.label}
            </h2>
            <div className="bg-surface-base border border-white/10 divide-y divide-white/10">
              {group.scopes.map(({ scope, label }) => {
                const pref = getPref(scope);
                return (
                  <div key={scope} className="flex items-center justify-between px-4 py-3">
                    <span className="text-sm text-primary">{label}</span>
                    <div className="flex items-center gap-6">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <span className="text-xs text-muted">In-app</span>
                        <button
                          onClick={() => toggle(scope, 'inapp', !pref.inapp)}
                          disabled={saving === `${scope}:inapp`}
                          className={`relative inline-flex h-5 w-9 items-center transition-colors focus:outline-none ${
                            pref.inapp ? 'bg-white' : 'bg-surface-elevated'
                          }`}
                        >
                          <span
                            className={`inline-block h-3 w-3 transform rounded-full bg-surface-base transition-transform ${
                              pref.inapp ? 'translate-x-5' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <span className="text-xs text-muted">Email</span>
                        <button
                          onClick={() => toggle(scope, 'email', !pref.email)}
                          disabled={saving === `${scope}:email`}
                          className={`relative inline-flex h-5 w-9 items-center transition-colors focus:outline-none ${
                            pref.email ? 'bg-white' : 'bg-surface-elevated'
                          }`}
                        >
                          <span
                            className={`inline-block h-3 w-3 transform rounded-full bg-surface-base transition-transform ${
                              pref.email ? 'translate-x-5' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
