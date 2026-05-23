'use client';

import { useState, useEffect } from 'react';
import { SERVICES, buildPublicUrl } from '@imajin/config';

interface IdentityConfig {
  enabledServices: string[];
  landingService: string | null;
  joinVisibility: 'open' | 'network' | 'invite';
  joinNetworkDepth: number;
  scopeFeeBps: number;
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

export default function IdentitySettingsPanel({ groupDid }: Readonly<{ groupDid: string }>) {
  const [loading, setLoading] = useState(true);
  const [enabledServices, setEnabledServices] = useState<string[]>([]);
  const [landingService, setLandingService] = useState<string | null>(null);
  const [joinVisibility, setJoinVisibility] = useState<'open' | 'network' | 'invite'>('open');
  const [joinNetworkDepth, setJoinNetworkDepth] = useState<number>(2);
  const [scopeFeeBps, setScopeFeeBps] = useState<number>(25);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy');

  const authUrl =
    typeof window !== 'undefined' ? globalThis.location.origin : (process.env.NEXT_PUBLIC_AUTH_URL ?? '');
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
        setJoinVisibility(cfg.joinVisibility ?? 'open');
        setJoinNetworkDepth(cfg.joinNetworkDepth ?? 2);
        setScopeFeeBps(cfg.scopeFeeBps ?? 25);
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
          body: JSON.stringify({
            enabledServices,
            landingService,
            joinVisibility,
            joinNetworkDepth,
            scopeFeeBps,
          }),
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
    return <div className="text-gray-400 py-8">Loading settings…</div>;
  }

  const enabledServiceOptions = SELECTABLE_SERVICES.filter((s) => enabledServices.includes(s.name));

  return (
    <div className="space-y-6">
      {status && (
        <div
          className={`p-4 rounded-lg border ${
            status.type === 'success'
              ? 'bg-green-900/20 border-green-800 text-green-400'
              : 'bg-red-900/20 border-red-800 text-red-400'
          }`}
        >
          {status.text}
        </div>
      )}

      {/* Included (kernel) services */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
          Included with every identity
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          These core services are always available and cannot be disabled.
        </p>
        <div className="flex flex-wrap gap-2">
          {KERNEL_SERVICES.map((svc) => (
            <span
              key={svc.name}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-800 bg-gray-900/50 text-gray-500 text-sm"
            >
              <span>{svc.icon}</span>
              <span>{svc.label}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Selectable services */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
          Available Apps
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Toggle which apps are available for this identity.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {SELECTABLE_SERVICES.map((svc) => {
            const isEnabled = enabledServices.includes(svc.name);
            return (
              <button
                key={svc.name}
                onClick={() => toggleService(svc.name)}
                className={`flex flex-col items-start gap-1 p-3 rounded-xl border transition text-left ${
                  isEnabled
                    ? 'border-amber-500/60 bg-amber-500/10 text-white'
                    : 'border-gray-800 bg-gray-900/30 text-gray-500 hover:border-gray-700 hover:text-gray-400'
                }`}
              >
                <span className="text-xl">{svc.icon}</span>
                <span className="text-sm font-medium leading-tight">{svc.label}</span>
                <span
                  className={`text-xs leading-tight ${isEnabled ? 'text-amber-400/70' : 'text-gray-600'}`}
                >
                  {isEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Landing page */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
          Landing Page
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Choose which app loads first for this identity.
        </p>
        <select
          value={landingService ?? ''}
          onChange={(e) => setLandingService(e.target.value || null)}
          className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
        >
          <option value="">— Default (no preference) —</option>
          {enabledServiceOptions.map((svc) => (
            <option key={svc.name} value={svc.name}>
              {svc.icon} {svc.label}
            </option>
          ))}
        </select>
        {enabledServiceOptions.length === 0 && (
          <p className="text-xs text-gray-600 mt-2">
            Enable at least one app to set a landing page.
          </p>
        )}
      </div>

      {/* Join Visibility */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
          Join Visibility
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Control who can see the join button on your community profile.
        </p>

        <div className="space-y-4">
          <select
            value={joinVisibility}
            onChange={(e) => setJoinVisibility(e.target.value as 'open' | 'network' | 'invite')}
            className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          >
            <option value="open">🌐 Open — Anyone can join</option>
            <option value="network">🔗 Network — Connections of members</option>
            <option value="invite">🔒 Invite Only — Onboard link only</option>
          </select>

          {joinVisibility === 'network' && (
            <div>
              <label className="block text-sm text-gray-400 mb-2">Network depth</label>
              <select
                value={joinNetworkDepth}
                onChange={(e) => setJoinNetworkDepth(Number(e.target.value))}
                className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              >
                <option value={1}>1 — Direct connections only</option>
                <option value={2}>2 — Friends of friends</option>
                <option value={3}>3 — Three degrees</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Scope Fee */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
          Scope Fee
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Fee taken from transactions within this community. Added to the .fair attribution chain.
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={0}
              max={500}
              step={5}
              value={scopeFeeBps}
              onChange={(e) => setScopeFeeBps(Number(e.target.value))}
              className="flex-1 accent-amber-500"
            />
            <span className="text-white font-mono text-sm w-16 text-right">
              {(scopeFeeBps / 100).toFixed(2)}%
            </span>
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>0%</span>
            <span>Default: 0.25%</span>
            <span>5%</span>
          </div>
          <p className="text-xs text-gray-500">
            {scopeFeeBps} basis points · Collected on every transaction within this scope
          </p>
        </div>
      </div>

      {/* Onboarding */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
          Onboarding
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Share this link to invite people to this identity.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-300 font-mono overflow-x-auto whitespace-nowrap">
            {onboardUrl}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(onboardUrl).then(() => {
                setCopyLabel('Copied!');
                setTimeout(() => setCopyLabel('Copy'), 2000);
              });
            }}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition whitespace-nowrap"
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
          className="px-6 py-2.5 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold rounded-lg transition disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
