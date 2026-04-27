'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SCOPES } from '@imajin/auth';

interface App {
  id: string;
  name: string;
  description: string | null;
  appDid: string;
  publicKey: string;
  callbackUrl: string;
  homepageUrl: string | null;
  logoUrl: string | null;
  requestedScopes: string[] | null;
  status: string;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

interface Props {
  app: App;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={copy}
      className="text-xs px-2 py-0.5 border border-white/10 text-muted hover:text-warning hover:border-amber-500/50 transition-colors"
    >
      {copied ? 'Copied!' : (label ?? 'Copy')}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">{label}</p>
      {children}
    </div>
  );
}

export default function AppDetailClient({ app: initialApp }: Props) {
  const router = useRouter();
  const [app, setApp] = useState(initialApp);
  const [editing, setEditing] = useState(false);
  const [showRevoke, setShowRevoke] = useState(false);

  // Edit state
  const [editName, setEditName] = useState(app.name);
  const [editDescription, setEditDescription] = useState(app.description ?? '');
  const [editCallbackUrl, setEditCallbackUrl] = useState(app.callbackUrl);
  const [editHomepageUrl, setEditHomepageUrl] = useState(app.homepageUrl ?? '');
  const [editLogoUrl, setEditLogoUrl] = useState(app.logoUrl ?? '');
  const [editScopes, setEditScopes] = useState<string[]>(app.requestedScopes ?? []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  function toggleEditScope(scope: string) {
    setEditScopes(prev =>
      prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]
    );
  }

  function startEdit() {
    setEditName(app.name);
    setEditDescription(app.description ?? '');
    setEditCallbackUrl(app.callbackUrl);
    setEditHomepageUrl(app.homepageUrl ?? '');
    setEditLogoUrl(app.logoUrl ?? '');
    setEditScopes(app.requestedScopes ?? []);
    setSaveError('');
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(`/api/registry/apps/${app.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          callbackUrl: editCallbackUrl.trim(),
          homepageUrl: editHomepageUrl.trim() || null,
          logoUrl: editLogoUrl.trim() || null,
          requestedScopes: editScopes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data.error || 'Save failed');
        return;
      }
      setApp(data);
      setEditing(false);
    } catch {
      setSaveError('Network error — please try again');
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    setRevoking(true);
    setRevokeError('');
    try {
      const res = await fetch(`/api/registry/apps/${app.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        setRevokeError(data.error || 'Revoke failed');
        return;
      }
      router.push('/auth/developer/apps');
    } catch {
      setRevokeError('Network error — please try again');
    } finally {
      setRevoking(false);
    }
  }

  const scopes = app.requestedScopes ?? [];
  const createdAt = app.createdAt ? new Date(app.createdAt).toLocaleString() : '—';
  const updatedAt = app.updatedAt ? new Date(app.updatedAt).toLocaleString() : '—';

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="bg-surface-base border border-white/10 p-6 space-y-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-primary font-mono">Edit App</h2>
            <button
              onClick={() => setEditing(false)}
              className="text-muted hover:text-zinc-300 text-sm transition-colors"
            >
              Cancel
            </button>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Name <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              required
              maxLength={100}
              className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Description
            </label>
            <textarea
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
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
              value={editCallbackUrl}
              onChange={e => setEditCallbackUrl(e.target.value)}
              required
              className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
            />
          </div>

          {/* Homepage URL */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Homepage URL
            </label>
            <input
              type="url"
              value={editHomepageUrl}
              onChange={e => setEditHomepageUrl(e.target.value)}
              className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
            />
          </div>

          {/* Logo URL */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Logo URL
            </label>
            <input
              type="url"
              value={editLogoUrl}
              onChange={e => setEditLogoUrl(e.target.value)}
              className="w-full bg-surface-elevated border border-white/10 px-3 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors text-sm"
            />
          </div>

          {/* Scopes */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-2">
              Requested Scopes
            </label>
            <div className="space-y-1.5">
              {Object.entries(SCOPES).map(([scope, label]) => (
                <label key={scope} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editScopes.includes(scope)}
                    onChange={() => toggleEditScope(scope)}
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

          {saveError && (
            <p className="text-sm text-error bg-error/20 border border-red-800/40 px-3 py-2.5">
              {saveError}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="flex-1 px-4 py-2.5 bg-surface-elevated border border-white/10 text-secondary hover:text-primary transition-colors text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !editName.trim() || !editCallbackUrl.trim()}
              className="flex-1 px-4 py-2.5 bg-warning hover:bg-warning disabled:bg-warning/20 disabled:text-warning text-black font-semibold transition-colors text-sm"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-surface-base border border-white/10 p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-base font-semibold text-primary font-mono">{app.name}</h1>
              <span className={`text-[10px] px-1.5 py-0.5 border ${
                app.status === 'active'
                  ? 'bg-success/30 border-green-800/50 text-success'
                  : 'bg-error/30 border-red-800/50 text-error'
              }`}>
                {app.status}
              </span>
            </div>
            {app.description && (
              <p className="text-sm text-secondary">{app.description}</p>
            )}
          </div>
          {app.status === 'active' && (
            <button
              onClick={startEdit}
              className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-elevated border border-white/10 text-zinc-300 text-sm transition-colors shrink-0"
            >
              Edit
            </button>
          )}
        </div>

        <div className="grid gap-3 pt-2 border-t border-white/10">
          <Field label="App ID">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-zinc-300">{app.id}</span>
              <CopyButton text={app.id} />
            </div>
          </Field>

          <Field label="App DID">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-zinc-300 break-all">{app.appDid}</span>
              <CopyButton text={app.appDid} />
            </div>
          </Field>

          <Field label="Public Key">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-secondary break-all">{app.publicKey}</span>
              <CopyButton text={app.publicKey} />
            </div>
          </Field>

          <Field label="Callback URL">
            <span className="text-sm text-zinc-300">{app.callbackUrl}</span>
          </Field>

          {app.homepageUrl && (
            <Field label="Homepage URL">
              <span className="text-sm text-zinc-300">{app.homepageUrl}</span>
            </Field>
          )}

          {app.logoUrl && (
            <Field label="Logo URL">
              <span className="text-sm text-zinc-300">{app.logoUrl}</span>
            </Field>
          )}

          {scopes.length > 0 && (
            <Field label="Requested Scopes">
              <div className="flex flex-wrap gap-1.5 mt-1">
                {scopes.map(scope => (
                  <span key={scope} className="text-xs px-2 py-0.5 bg-surface-elevated border border-white/10 text-zinc-300 font-mono">
                    {scope}
                  </span>
                ))}
              </div>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-white/10">
            <Field label="Created">
              <span className="text-xs text-secondary">{createdAt}</span>
            </Field>
            <Field label="Updated">
              <span className="text-xs text-secondary">{updatedAt}</span>
            </Field>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      {app.status === 'active' && (
        <div className="bg-surface-base border border-red-900/40 p-5">
          <h3 className="text-sm font-semibold text-error mb-1 font-mono">Danger Zone</h3>
          <p className="text-xs text-muted mb-3">
            Revoking this app will immediately invalidate all active sessions and prevent any new authorizations.
          </p>

          {!showRevoke ? (
            <button
              onClick={() => setShowRevoke(true)}
              className="px-4 py-2 border border-red-900/60 text-error hover:bg-error/20 text-sm transition-colors"
            >
              Revoke App
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-error">
                Are you sure you want to revoke <strong>{app.name}</strong>? This cannot be undone.
              </p>
              {revokeError && (
                <p className="text-sm text-error bg-error/20 border border-red-800/40 px-3 py-2">
                  {revokeError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setShowRevoke(false)}
                  className="px-4 py-2 bg-surface-elevated border border-white/10 text-secondary hover:text-primary text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRevoke}
                  disabled={revoking}
                  className="px-4 py-2 bg-error hover:bg-error disabled:opacity-50 text-primary font-semibold text-sm transition-colors"
                >
                  {revoking ? 'Revoking…' : 'Yes, Revoke App'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
