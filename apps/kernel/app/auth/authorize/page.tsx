'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SCOPES } from '@imajin/auth';
import type { Scope } from '@imajin/auth';

interface AppInfo {
  id: string;
  name: string;
  description: string | null;
  appDid: string;
  homepageUrl: string | null;
  logoUrl: string | null;
  callbackUrl: string;
  requestedScopes: string[];
}

function AuthorizeForm() {
  const searchParams = useSearchParams();
  const appId = searchParams.get('app_id');
  const requestedParam = searchParams.get('scopes');

  const [app, setApp] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledScopes, setEnabledScopes] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!appId) {
      setError('Missing app_id parameter');
      setLoading(false);
      return;
    }

    fetch(`/api/registry/apps/${appId}`)
      .then(res => {
        if (!res.ok) throw new Error('App not found');
        return res.json();
      })
      .then((data: AppInfo) => {
        setApp(data);

        // Scopes from URL (what the app is requesting right now), filtered against what the app registered
        const urlScopes = requestedParam ? requestedParam.split(',').map(s => s.trim()).filter(Boolean) : [];
        const applicableScopes = urlScopes.length > 0
          ? urlScopes.filter(s => data.requestedScopes.includes(s))
          : data.requestedScopes;

        const initial: Record<string, boolean> = {};
        for (const s of applicableScopes) initial[s] = true;
        setEnabledScopes(initial);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [appId, requestedParam]);

  function handleDeny() {
    if (!app) return;
    const url = new URL(app.callbackUrl);
    url.searchParams.set('error', 'denied');
    window.location.href = url.toString();
  }

  async function handleAuthorize() {
    if (!app || submitting) return;
    setSubmitting(true);

    const granted = Object.entries(enabledScopes)
      .filter(([, on]) => on)
      .map(([scope]) => scope);

    try {
      const res = await fetch('/api/auth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ appId: app.id, scopes: granted }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Authorization failed');
        setSubmitting(false);
        return;
      }

      const { attestationId, userDid } = await res.json();
      const url = new URL(app.callbackUrl);
      url.searchParams.set('attestation_id', attestationId);
      url.searchParams.set('user_did', userDid);
      window.location.href = url.toString();
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-secondary">Loading...</p>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0a0a0a] border border-red-800 p-8 text-center">
          <p className="text-error">{error ?? 'App not found'}</p>
        </div>
      </div>
    );
  }

  const scopeEntries = Object.entries(enabledScopes);

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-[#0a0a0a] border border-white/10 p-8">
          {/* App header */}
          <div className="flex items-center gap-3 mb-6">
            {app.logoUrl ? (
              <img src={app.logoUrl} alt={app.name} className="w-12 h-12 object-cover" />
            ) : (
              <div className="w-12 h-12 bg-surface-elevated flex items-center justify-center text-xl font-bold text-secondary">
                {app.name[0].toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-bold text-primary font-mono">{app.name}</h1>
              {app.homepageUrl && (
                <p className="text-xs text-secondary truncate max-w-xs">{app.homepageUrl}</p>
              )}
            </div>
          </div>

          <p className="text-secondary text-sm mb-6">
            {app.description ?? `${app.name} is requesting access to your Imajin account.`}
          </p>

          {/* Scope toggles */}
          {scopeEntries.length > 0 ? (
            <div className="space-y-2 mb-6">
              <p className="text-xs text-secondary uppercase tracking-wide mb-3">Permissions requested</p>
              {scopeEntries.map(([scope, enabled]) => (
                <label
                  key={scope}
                  className="flex items-center justify-between p-3 bg-surface-surface border border-white/10 cursor-pointer hover:border-white/10 transition"
                >
                  <div>
                    <p className="text-sm font-medium text-primary">{scope}</p>
                    <p className="text-xs text-secondary mt-0.5">
                      {SCOPES[scope as Scope] ?? scope}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabledScopes(prev => ({ ...prev, [scope]: e.target.checked }))}
                    className="ml-3 w-4 h-4 accent-[#F59E0B] cursor-pointer"
                  />
                </label>
              ))}
            </div>
          ) : (
            <div className="mb-6 p-3 bg-surface-surface border border-white/10">
              <p className="text-sm text-secondary">This app requests basic access (no specific permissions).</p>
            </div>
          )}

          {/* Trust notice */}
          <div className="mb-6 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30">
            <p className="text-xs text-[#F59E0B]">
              Only authorize apps you trust. You can revoke access at any time from your settings.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleDeny}
              className="flex-1 px-4 py-2.5 bg-surface-surface text-primary hover:bg-surface-elevated transition font-medium text-sm"
            >
              Deny
            </button>
            <button
              onClick={handleAuthorize}
              disabled={submitting}
              className="flex-1 px-4 py-2.5 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-medium text-sm disabled:opacity-50"
            >
              {submitting ? 'Authorizing...' : 'Authorize'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-secondary">Loading...</p>
      </div>
    }>
      <AuthorizeForm />
    </Suspense>
  );
}
