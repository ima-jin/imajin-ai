'use client';

import { useState, useEffect } from 'react';
import { SERVICES, buildPublicUrl } from '@imajin/config';

interface IdentityConfig {
  enabledServices: string[];
  landingService: string | null;
  theme: Record<string, unknown>;
}

const KERNEL_SERVICES = SERVICES.filter((s) => s.category === 'kernel' && s.visibility !== 'internal');

const SELECTABLE_SERVICES = SERVICES.filter(
  (s) =>
    s.visibility !== 'internal' &&
    s.category !== 'meta' &&
    s.category !== 'infrastructure' &&
    s.category !== 'kernel'
);

export default function IdentitySettingsPanel({ groupDid }: { groupDid: string }) {
  const [loading, setLoading] = useState(true);
  const [enabledServices, setEnabledServices] = useState<string[]>([]);
  const [landingService, setLandingService] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy');

  const authUrl =
    typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_AUTH_URL ?? '');
  const profileUrl = buildPublicUrl('profile');
  const onboardUrl = `${authUrl}/auth/onboard?scope=${encodeURIComponent(groupDid)}`;

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDid]);

  async function loadData() {
    setLoading(true);
    try {
      const configRes = await fetch(
        `${profileUrl}/api/forest/${encodeURIComponent(groupDid)}/config`,
        { credentials: 'include' }
      );
      if (configRes.ok) {
        const cfg: IdentityConfig = await configRes.json();
        setEnabledServices(cfg.enabledServices ?? []);
        setLandingService(cfg.landingService ?? null);
      }
    } catch (err) {
      console.error('Failed to load identity settings:', err);
    } finally {
      setLoading(false);
    }
  }

  function toggleService(name: string) {
    setEnabledServices((prev) => {
      const next = prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name];
      if (landingService && !next.includes(landingService)) {
        setLandingService(null);
      }
      return next;
    });
  }

  function showStatus(type: 'success' | 'error', text: string) {
    setStatus({ type, text });
    setTimeout(() => setStatus(null), 5000);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `${profileUrl}/api/forest/${encodeURIComponent(groupDid)}/config`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ enabledServices, landingService }),
        }
      );
      if (res.ok) {
        showStatus('success', 'Settings saved.');
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to save settings.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-secondary py-8">Loading settings…</div>;
  }

  const enabledServiceOptions = SELECTABLE_SERVICES.filter((s) => enabledServices.includes(s.name));

  return (
    <div className="space-y-6">
      {status && (
        <div
          className={`p-4 border ${
            status.type === 'success'
              ? 'bg-success/20 border-green-800 text-success'
              : 'bg-error/20 border-red-800 text-error'
          }`}
        >
          {status.text}
        </div>
      )}

      {/* Included (kernel) services */}
      <div className="bg-[#0a0a0a] border border-white/10 p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-secondary mb-1 font-mono">
          Included with every identity
        </h2>
        <p className="text-sm text-secondary mb-4">
          These core services are always available and cannot be disabled.
        </p>
        <div className="flex flex-wrap gap-2">
          {KERNEL_SERVICES.map((svc) => (
            <span
              key={svc.name}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-white/10 bg-surface-surface/50 text-secondary text-sm"
            >
              <span>{svc.icon}</span>
              <span>{svc.label}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Selectable services */}
      <div className="bg-[#0a0a0a] border border-white/10 p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-secondary mb-1 font-mono">
          Available Apps
        </h2>
        <p className="text-sm text-secondary mb-4">
          Toggle which apps are available for this identity.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {SELECTABLE_SERVICES.map((svc) => {
            const isEnabled = enabledServices.includes(svc.name);
            return (
              <button
                key={svc.name}
                onClick={() => toggleService(svc.name)}
                className={`flex flex-col items-start gap-1 p-3 border transition text-left ${
                  isEnabled
                    ? 'border-amber-500/60 bg-warning/10 text-primary'
                    : 'border-white/10 bg-surface-surface/30 text-secondary hover:border-white/10 hover:text-secondary'
                }`}
              >
                <span className="text-xl">{svc.icon}</span>
                <span className="text-sm font-medium leading-tight">{svc.label}</span>
                <span
                  className={`text-xs leading-tight ${isEnabled ? 'text-warning/70' : 'text-muted'}`}
                >
                  {isEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Landing page */}
      <div className="bg-[#0a0a0a] border border-white/10 p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-secondary mb-1 font-mono">
          Landing Page
        </h2>
        <p className="text-sm text-secondary mb-4">
          Choose which app loads first for this identity.
        </p>
        <select
          value={landingService ?? ''}
          onChange={(e) => setLandingService(e.target.value || null)}
          className="w-full px-4 py-2 border border-white/10 bg-surface-base text-primary focus:ring-2 focus:ring-amber-500 focus:border-transparent"
        >
          <option value="">— Default (no preference) —</option>
          {enabledServiceOptions.map((svc) => (
            <option key={svc.name} value={svc.name}>
              {svc.icon} {svc.label}
            </option>
          ))}
        </select>
        {enabledServiceOptions.length === 0 && (
          <p className="text-xs text-muted mt-2">
            Enable at least one app to set a landing page.
          </p>
        )}
      </div>

      {/* Onboarding */}
      <div className="bg-[#0a0a0a] border border-white/10 p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-secondary mb-1 font-mono">
          Onboarding
        </h2>
        <p className="text-sm text-secondary mb-4">
          Share this link to invite people to this identity.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-surface-surface border border-white/10 text-sm text-primary font-mono overflow-x-auto whitespace-nowrap">
            {onboardUrl}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(onboardUrl).then(() => {
                setCopyLabel('Copied!');
                setTimeout(() => setCopyLabel('Copy'), 2000);
              });
            }}
            className="px-3 py-2 bg-surface-elevated hover:bg-surface-elevated border border-white/10 text-sm text-primary transition whitespace-nowrap"
          >
            {copyLabel}
          </button>
        </div>
      </div>

      {/* Save button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 bg-warning hover:bg-warning text-gray-950 font-semibold transition disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
