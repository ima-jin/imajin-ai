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

  // This screen serves two lanes:
  //  - OAuth (MCP connector): carries client_id + PKCE; commits to /oauth/authorize.
  //  - Keypair app: carries app_id; commits to /api/auth/authorize.
  const oauthClientId = searchParams.get('client_id');
  const oauthCodeChallenge = searchParams.get('code_challenge');
  const isOAuth = Boolean(oauthClientId && oauthCodeChallenge);

  const appId = isOAuth ? oauthClientId : searchParams.get('app_id');
  // OAuth `scope` is space-delimited; keypair `scopes` is comma-delimited.
  const requestedParam = isOAuth ? searchParams.get('scope') : searchParams.get('scopes');

  // OAuth commit params (unused in keypair mode).
  const redirectUri = searchParams.get('redirect_uri');
  const state = searchParams.get('state');
  const codeChallengeMethod = searchParams.get('code_challenge_method');
  const resource = searchParams.get('resource');

  const [app, setApp] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledScopes, setEnabledScopes] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!appId) {
      setError(isOAuth ? 'Missing client_id parameter' : 'Missing app_id parameter');
      setLoading(false);
      return;
    }

    // Check if user is logged in before showing consent screen
    fetch('/profile/api/auth/session', { credentials: 'include' })
      .then(res => res.json())
      .then(session => {
        if (!session?.did) {
          // Not logged in — redirect to login, then back here
          const returnUrl = encodeURIComponent(globalThis.location.href);
          globalThis.location.href = `/auth/login?redirect=${returnUrl}`;
          return;
        }
        return fetch(`/api/registry/apps/${appId}`);
      })
      .then(res => {
        if (!res) return; // redirecting to login
        if (!res.ok) throw new Error('App not found');
        return res.json();
      })
      .then((data?: AppInfo) => {
        if (!data) return; // redirecting to login
        setApp(data);

        // Scopes from URL (what the actor is requesting now), filtered against what it registered.
        const scopeSeparator = isOAuth ? /\s+/ : ',';
        const urlScopes = requestedParam
          ? requestedParam.split(scopeSeparator).map(s => s.trim()).filter(Boolean)
          : [];
        const applicableScopes = urlScopes.length > 0
          ? urlScopes.filter(s => data.requestedScopes.includes(s))
          : data.requestedScopes;

        const initial: Record<string, boolean> = {};
        for (const s of applicableScopes) initial[s] = true;
        setEnabledScopes(initial);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [appId, requestedParam, isOAuth]);

  function handleDeny() {
    if (isOAuth) {
      if (!redirectUri) return;
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      globalThis.location.href = url.toString();
      return;
    }
    if (!app) return;
    const url = new URL(app.callbackUrl);
    url.searchParams.set('error', 'denied');
    globalThis.location.href = url.toString();
  }

  async function handleAuthorize() {
    if (!app || submitting) return;
    setSubmitting(true);

    const granted = Object.entries(enabledScopes)
      .filter(([, on]) => on)
      .map(([scope]) => scope);

    try {
      if (isOAuth) {
        // OAuth lane: commit consent, then follow the minted ?code redirect.
        const res = await fetch('/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            client_id: app.id,
            redirect_uri: redirectUri,
            state,
            code_challenge: oauthCodeChallenge,
            code_challenge_method: codeChallengeMethod ?? 'S256',
            scope: granted.join(' '),
            resource,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error_description ?? data.error ?? 'Authorization failed');
          setSubmitting(false);
          return;
        }

        const { redirect } = await res.json();
        globalThis.location.href = redirect;
        return;
      }

      // Keypair lane.
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
      globalThis.location.href = url.toString();
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0a0a0a] border border-red-800 rounded-2xl p-8 text-center">
          <p className="text-red-400">{error ?? 'App not found'}</p>
        </div>
      </div>
    );
  }

  const scopeEntries = Object.entries(enabledScopes);
  // Delegate (OAuth connector acting on the user's behalf) vs peer (keypair app
  // that is its own actor) — make the relationship legible (#1171).
  const actorKind = isOAuth ? 'Delegate · acts on your behalf' : 'Peer · its own actor';

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          {/* App header */}
          <div className="flex items-center gap-3 mb-6">
            {app.logoUrl ? (
              <img src={app.logoUrl} alt={app.name} className="w-12 h-12 rounded-xl object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center text-xl font-bold text-gray-400">
                {app.name[0].toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-bold text-white">{app.name}</h1>
              {app.homepageUrl && (
                <p className="text-xs text-gray-500 truncate max-w-xs">{app.homepageUrl}</p>
              )}
              <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-gray-800 text-[10px] uppercase tracking-wide text-gray-400">
                {actorKind}
              </span>
            </div>
          </div>

          <p className="text-gray-400 text-sm mb-6">
            {app.description ?? `Grant access to the ${app.name} actor in your graph. It becomes an actor you can see and revoke at any time.`}
          </p>

          {/* Scope toggles */}
          {scopeEntries.length > 0 ? (
            <div className="space-y-2 mb-6">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-3">Access this actor will have</p>
              {scopeEntries.map(([scope, enabled]) => (
                <label
                  key={scope}
                  htmlFor={`authorize-scope-${scope}`}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-900 border border-gray-800 cursor-pointer hover:border-gray-700 transition"
                >
                  <div>
                    <p className="text-sm font-medium text-white">{scope}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {SCOPES[scope as Scope] ?? scope}
                    </p>
                  </div>
                  <input
                    id={`authorize-scope-${scope}`}
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabledScopes(prev => ({ ...prev, [scope]: e.target.checked }))}
                    className="ml-3 w-4 h-4 accent-[#F59E0B] cursor-pointer"
                    aria-label={scope}
                  />
                </label>
              ))}
            </div>
          ) : (
            <div className="mb-6 p-3 bg-gray-900 border border-gray-800 rounded-lg">
              <p className="text-sm text-gray-400">This actor requests basic access (no specific permissions).</p>
            </div>
          )}

          {/* Trust notice */}
          <div className="mb-6 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg">
            <p className="text-xs text-[#F59E0B]">
              Only grant access to actors you trust. You can revoke access at any time from your settings.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleDeny}
              className="flex-1 px-4 py-2.5 rounded-lg bg-gray-900 text-gray-300 hover:bg-gray-800 transition font-medium text-sm"
            >
              Deny
            </button>
            <button
              onClick={handleAuthorize}
              disabled={submitting}
              className="flex-1 px-4 py-2.5 rounded-lg bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-medium text-sm disabled:opacity-50"
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
        <p className="text-gray-400">Loading...</p>
      </div>
    }>
      <AuthorizeForm />
    </Suspense>
  );
}
