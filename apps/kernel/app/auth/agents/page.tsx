'use client';

import { useState, useEffect, useCallback } from 'react';
import { buildPublicUrlAbsolute } from '@imajin/config';

const NODE_URL = buildPublicUrlAbsolute('kernel');

interface GrantCapability {
  capability: string;
  status: 'active' | 'revoked';
  revokedAt: string | null;
}

interface GrantHistoryEntry {
  event: 'issued' | 'renewed' | 'revoked' | 'capability_revoked';
  capability: string | null;
  actorDid: string;
  createdAt: string;
}

interface Grant {
  grantId: string;
  agentDid: string;
  delegatorDid: string;
  audience: { type: 'all' } | { type: 'dids'; values: string[] };
  onBehalfOf: string[];
  issuedAt: string;
  expiresAt: string;
  status: 'active' | 'expiring' | 'expired' | 'revoked';
  revokedAt: string | null;
  lastUsedAt: string | null;
  capabilities: GrantCapability[];
  history: GrantHistoryEntry[];
}

interface Agent {
  did: string;
  handle: string | null;
  displayName: string | null;
  name: string | null;
  createdAt: string | null;
  tier: string;
  status: 'online' | 'offline';
  role: string;
  isExternal: boolean;
  externalDid: string | null;
  grants: Grant[];
  hasLegacyMembership: boolean;
}

interface CreatedAgent {
  did: string;
  handle: string;
  displayName: string | null;
  keypair: {
    privateKey: string;
    publicKey: string;
  };
}

interface Session {
  did: string;
  handle?: string | null;
  name?: string | null;
}

interface PendingKnock {
  knockId: string;
  agentDid: string;
  selfDescription: string | null;
  requestedCapabilities: string[];
  externalDid: string | null;
  expiresAt: string;
  createdAt: string;
}

const GRANT_STATUS_STYLES: Record<Grant['status'], string> = {
  active: 'border-green-700 text-green-400 bg-green-900/20',
  expiring: 'border-amber-600 text-amber-400 bg-amber-900/20',
  expired: 'border-gray-700 text-gray-500 bg-gray-900/20',
  revoked: 'border-red-800 text-red-400 bg-red-900/20',
};

const HISTORY_EVENT_LABELS: Record<GrantHistoryEntry['event'], string> = {
  issued: 'Issued',
  renewed: 'Renewed',
  revoked: 'Revoked',
  capability_revoked: 'Capability revoked',
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "3 days left" / "expired 2 hours ago" — the read surface's "expiry (+ time-remaining)". */
function formatTimeRemaining(expiresAt: string): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let amount: number;
  let unit: string;
  if (absMs >= day) {
    amount = Math.round(absMs / day);
    unit = amount === 1 ? 'day' : 'days';
  } else if (absMs >= hour) {
    amount = Math.round(absMs / hour);
    unit = amount === 1 ? 'hour' : 'hours';
  } else {
    amount = Math.max(1, Math.round(absMs / minute));
    unit = amount === 1 ? 'minute' : 'minutes';
  }
  return diffMs >= 0 ? `${amount} ${unit} left` : `expired ${amount} ${unit} ago`;
}

function agentLabel(agent: Pick<Agent, 'displayName' | 'name' | 'handle' | 'did'>): string {
  return agent.displayName || agent.name || (agent.handle ? `@${agent.handle}` : agent.did);
}

/** One grant's detail card: capability chips, audience, lease, controls. */
function GrantCard({
  grant,
  actionLoading,
  onRevokeCapability,
  onRevokeAll,
  onRenew,
}: Readonly<{
  grant: Grant;
  actionLoading: string;
  onRevokeCapability: (grantId: string, capability: string) => void;
  onRevokeAll: (grantId: string) => void;
  onRenew: (grantId: string) => void;
}>) {
  const [expanded, setExpanded] = useState(false);
  const isRevoked = grant.status === 'revoked';
  const isExpired = grant.status === 'expired';
  const canAct = !isRevoked;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-1.5 py-0.5 text-xs rounded border capitalize ${GRANT_STATUS_STYLES[grant.status]}`}>
            {grant.status}
          </span>
          <span className="text-xs text-gray-500 font-mono" title={grant.grantId}>
            {grant.grantId}
          </span>
          {!isRevoked && !isExpired && (
            <span className="text-xs text-gray-500">{formatTimeRemaining(grant.expiresAt)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canAct && (
            <>
              <button
                type="button"
                onClick={() => onRenew(grant.grantId)}
                disabled={actionLoading === `renew-${grant.grantId}`}
                className="text-xs px-2 py-1 border border-gray-700 text-gray-300 rounded hover:border-amber-600 hover:text-amber-400 transition disabled:opacity-40"
              >
                {actionLoading === `renew-${grant.grantId}` ? '…' : 'Renew'}
              </button>
              <button
                type="button"
                onClick={() => onRevokeAll(grant.grantId)}
                disabled={actionLoading === `revoke-all-${grant.grantId}`}
                className="text-xs px-2 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition disabled:opacity-40"
              >
                {actionLoading === `revoke-all-${grant.grantId}` ? '…' : 'Revoke all'}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300 transition"
          >
            {expanded ? 'Hide detail' : 'Show detail'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {grant.capabilities.map((cap) => (
          <span
            key={cap.capability}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border ${
              cap.status === 'revoked'
                ? 'border-gray-800 text-gray-600 line-through'
                : 'border-violet-800 text-violet-300 bg-violet-950/30'
            }`}
          >
            {cap.capability}
            {canAct && cap.status === 'active' && (
              <button
                type="button"
                onClick={() => onRevokeCapability(grant.grantId, cap.capability)}
                disabled={actionLoading === `revoke-cap-${grant.grantId}-${cap.capability}`}
                title={`Revoke ${cap.capability}`}
                className="text-violet-500 hover:text-red-400 transition disabled:opacity-40"
              >
                {actionLoading === `revoke-cap-${grant.grantId}-${cap.capability}` ? '…' : '×'}
              </button>
            )}
          </span>
        ))}
      </div>

      {expanded && (
        <div className="pt-2 border-t border-gray-900 space-y-2 text-xs text-gray-500">
          <p>
            Audience:{' '}
            <span className="text-gray-300">
              {grant.audience.type === 'all' ? 'all' : grant.audience.values.join(', ')}
            </span>
          </p>
          <p>
            Issued: <span className="text-gray-300">{formatDateTime(grant.issuedAt)}</span>
          </p>
          <p>
            Expiry: <span className="text-gray-300">{formatDateTime(grant.expiresAt)}</span>
          </p>
          <p>
            Last used:{' '}
            <span className="text-gray-300">{grant.lastUsedAt ? formatDateTime(grant.lastUsedAt) : 'never'}</span>
          </p>
          {grant.revokedAt && (
            <p>
              Revoked: <span className="text-red-400">{formatDateTime(grant.revokedAt)}</span>
            </p>
          )}
          {grant.history.length > 0 && (
            <div>
              <p className="text-gray-600 mb-1">History</p>
              <ul className="space-y-0.5">
                {grant.history.map((entry, i) => (
                  <li key={`${entry.event}-${entry.createdAt}-${i}`}>
                    {HISTORY_EVENT_LABELS[entry.event]}
                    {entry.capability ? ` (${entry.capability})` : ''} — {formatDateTime(entry.createdAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pendingKnocks, setPendingKnocks] = useState<PendingKnock[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createdAgent, setCreatedAgent] = useState<CreatedAgent | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  // Form state
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');

  const handlePrefix = session?.handle ? `${session.handle}-jin` : '';

  function showStatus(type: 'success' | 'error', text: string) {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 5000);
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [agentsRes, sessionRes, knocksRes] = await Promise.all([
        fetch('/auth/api/agents', { credentials: 'include' }),
        fetch('/auth/api/session', { credentials: 'include' }),
        fetch('/auth/api/knock/pending', { credentials: 'include' }),
      ]);

      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setAgents(data.agents || []);
      }

      if (knocksRes.ok) {
        const data = await knocksRes.json();
        setPendingKnocks(data.knocks || []);
      }

      if (sessionRes.ok) {
        const data = await sessionRes.json();
        setSession(data);
      } else if (sessionRes.status === 401) {
        globalThis.location.href = '/auth/login?next=/auth/agents';
        return;
      }
    } catch {
      showStatus('error', 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function resetForm() {
    setHandle('');
    setDisplayName('');
    setBio('');
    setCreatedAgent(null);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!handle || handle.length < 3) {
      showStatus('error', 'Handle must be at least 3 characters');
      return;
    }

    setActionLoading('create');
    try {
      const res = await fetch('/auth/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ handle, displayName, bio }),
      });

      if (res.ok) {
        const data = await res.json();
        setCreatedAgent({
          did: data.did,
          handle: data.handle,
          displayName: data.displayName,
          keypair: data.keypair,
        });
        showStatus('success', `Agent "${data.handle}" created successfully.`);
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to create agent');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleKnockResponse(knockId: string, action: 'accept' | 'decline') {
    setActionLoading(`${action}-${knockId}`);
    try {
      const res = await fetch(`/auth/api/knock/${encodeURIComponent(knockId)}/${action}`, {
        method: 'POST',
        credentials: 'include',
      });

      if (res.ok) {
        showStatus('success', action === 'accept' ? 'Contact request accepted.' : 'Contact request declined.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || `Failed to ${action} the request`);
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleRevokeMembership(agentDid: string) {
    setActionLoading(`revoke-${agentDid}`);
    try {
      const res = await fetch(`/auth/api/agents/${encodeURIComponent(agentDid)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        showStatus('success', 'Legacy membership removed.');
        setRevokeConfirm(null);
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to revoke agent');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleRevokeCapability(grantId: string, capability: string) {
    const key = `revoke-cap-${grantId}-${capability}`;
    setActionLoading(key);
    try {
      const res = await fetch(
        `/auth/api/grants/${encodeURIComponent(grantId)}/capabilities/${encodeURIComponent(capability)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (res.ok) {
        showStatus('success', `Revoked ${capability}.`);
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to revoke capability');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleRevokeAll(grantId: string) {
    const key = `revoke-all-${grantId}`;
    setActionLoading(key);
    try {
      const res = await fetch(`/auth/api/grants/${encodeURIComponent(grantId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        showStatus('success', 'Grant revoked.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to revoke grant');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleRenew(grantId: string) {
    const key = `renew-${grantId}`;
    setActionLoading(key);
    try {
      const res = await fetch(`/auth/api/grants/${encodeURIComponent(grantId)}/renew`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        showStatus('success', 'Grant renewed.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to renew grant');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setActionLoading('');
    }
  }

  function downloadKeypair() {
    if (!createdAgent) return;
    const blob = new Blob(
      [JSON.stringify({
        did: createdAgent.did,
        handle: createdAgent.handle,
        ...createdAgent.keypair,
      }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `.agent-${createdAgent.handle}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyConfigSnippet() {
    if (!createdAgent) return;
    const snippet = JSON.stringify({
      plugins: {
        entries: {
          imajin: {
            config: {
          nodeUrl: NODE_URL,
          did: createdAgent.did,
          keypairPath: `/path/to/.agent-${createdAgent.handle}.json`,
        },
      },
    },
  },
}, null, 2);
    navigator.clipboard.writeText(snippet).then(() => {
      showStatus('success', 'Config copied to clipboard');
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-center text-gray-400">Loading agents…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">Agents</h1>
            <p className="text-gray-400 text-sm">Scoped delegation grants for agents that act on your behalf.</p>
          </div>
          <button type="button"
            onClick={() => { setShowCreateForm(true); resetForm(); }}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold rounded-lg transition-colors"
          >
            + Create Agent
          </button>
        </div>

        {/* Status message */}
        {statusMessage && (
          <div className={`p-4 rounded-lg border ${statusMessage.type === 'success' ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-red-900/20 border-red-800 text-red-400'}`}>
            {statusMessage.text}
          </div>
        )}

        {/* Create agent form */}
        {showCreateForm && !createdAgent && (
          <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
            <h2 className="text-lg font-semibold text-white mb-4">Create new agent</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label htmlFor="create-agent-handle" className="block text-sm text-gray-400 mb-1">Handle</label>
                <div className="flex items-center gap-2">
                  {handlePrefix && (
                    <span className="text-sm text-gray-500 shrink-0">{handlePrefix}-</span>
                  )}
                  <input
                    id="create-agent-handle"
                    type="text"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                    placeholder={handlePrefix ? 'travel' : 'veteze-jin-travel'}
                    autoFocus
                    className="flex-1 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  />
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  Lowercase letters, numbers, underscores, and hyphens only.
                </p>
              </div>
              <div>
                <label htmlFor="create-agent-display-name" className="block text-sm text-gray-400 mb-1">Display name</label>
                <input
                  id="create-agent-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Travel Agent"
                  className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="create-agent-bio" className="block text-sm text-gray-400 mb-1">Bio</label>
                <textarea
                  id="create-agent-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Helps plan trips"
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-none"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={!handle || handle.length < 3 || actionLoading === 'create'}
                  className="px-6 py-2 bg-amber-500 hover:bg-amber-400 text-black font-medium rounded-lg transition disabled:opacity-50"
                >
                  {actionLoading === 'create' ? 'Creating…' : 'Create Agent'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateForm(false); resetForm(); }}
                  className="px-6 py-2 border border-gray-700 text-gray-400 hover:text-white rounded-lg transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Post-creation: keypair and config */}
        {createdAgent && (
          <div className="bg-amber-900/10 border border-amber-700/50 rounded-2xl p-8 space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Agent created!</h2>
              <p className="text-sm text-gray-400">
                <strong className="text-amber-400">Save this keypair now.</strong> It will never be shown again.
              </p>
            </div>

            <div className="bg-black border border-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-mono">{createdAgent.handle}</span>
                <span className="text-xs text-gray-500 font-mono">{createdAgent.did}</span>
              </div>
              <div className="flex gap-3">
                <button type="button"
                  onClick={downloadKeypair}
                  className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-black text-sm font-medium rounded-lg transition"
                >
                  Download Keypair JSON
                </button>
                <button type="button"
                  onClick={copyConfigSnippet}
                  className="flex-1 px-4 py-2 border border-amber-700 text-amber-400 hover:bg-amber-900/20 text-sm font-medium rounded-lg transition"
                >
                  Copy OpenClaw Config
                </button>
              </div>
            </div>

            <div className="bg-black border border-gray-800 rounded-lg p-4">
              <p className="text-xs text-gray-500 mb-2">OpenClaw config snippet:</p>
              <pre className="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">
{JSON.stringify({
  plugins: {
    entries: {
      imajin: {
        config: {
          nodeUrl: NODE_URL,
          did: createdAgent.did,
          keypairPath: `/path/to/.agent-${createdAgent.handle}.json`,
        },
      },
    },
  },
}, null, 2)}
              </pre>
            </div>

            <button type="button"
              onClick={() => { setCreatedAgent(null); setShowCreateForm(false); }}
              className="text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Done
            </button>
          </div>
        )}

        {/* Pending contact requests (knocks, #1883) */}
        {pendingKnocks.length > 0 && (
          <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
            <h2 className="text-lg font-semibold text-white mb-1">Pending contact requests</h2>
            <p className="text-gray-400 text-sm mb-6">
              External agents that have knocked, declaring you as their target. Accepting creates an identity only — it grants zero capabilities. Grant capabilities separately from an agent&apos;s detail view once it&apos;s in your agents list below.
            </p>
            <div className="space-y-3">
              {pendingKnocks.map((knock) => (
                <div key={knock.knockId} className="p-4 bg-gray-900 rounded-xl border border-gray-800">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm">{knock.selfDescription || 'No description provided.'}</p>
                      <p className="text-xs text-gray-600 font-mono mt-1 truncate">{knock.agentDid}</p>
                      {knock.externalDid && (
                        <p className="text-xs text-gray-600 mt-1">Claims external identity: <span className="font-mono">{knock.externalDid}</span></p>
                      )}
                      {knock.requestedCapabilities.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {knock.requestedCapabilities.map((cap) => (
                            <span key={cap} className="px-1.5 py-0.5 text-xs rounded border border-gray-700 text-gray-400">
                              {cap} <span className="text-gray-600">(requested, advisory only)</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2 flex-shrink-0">
                      <button type="button"
                        onClick={() => handleKnockResponse(knock.knockId, 'accept')}
                        disabled={actionLoading === `accept-${knock.knockId}` || actionLoading === `decline-${knock.knockId}`}
                        className="text-xs px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black rounded transition disabled:opacity-50"
                      >
                        {actionLoading === `accept-${knock.knockId}` ? '…' : 'Accept'}
                      </button>
                      <button type="button"
                        onClick={() => handleKnockResponse(knock.knockId, 'decline')}
                        disabled={actionLoading === `accept-${knock.knockId}` || actionLoading === `decline-${knock.knockId}`}
                        className="text-xs px-3 py-1 border border-gray-700 text-gray-400 rounded hover:text-white transition disabled:opacity-50"
                      >
                        {actionLoading === `decline-${knock.knockId}` ? '…' : 'Decline'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Agents list — grants view (#1887): one list, local and external agents alike */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-6">Your agents</h2>

          {agents.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-4xl mb-3">🤖</div>
              <p className="text-gray-400 text-sm mb-2">No agents yet</p>
              <p className="text-gray-600 text-xs">
                Create an agent to let it act on your behalf across the Imajin network.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {agents.map((agent) => (
                <div
                  key={agent.did}
                  className="p-4 bg-gray-900 rounded-xl border border-gray-800 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-lg">{agent.isExternal ? '🌐' : '🤖'}</span>
                        <span className="text-white font-medium">{agentLabel(agent)}</span>
                        <span
                          className={`px-1.5 py-0.5 text-xs rounded border ${
                            agent.isExternal
                              ? 'border-sky-700 text-sky-400 bg-sky-900/20'
                              : 'border-gray-700 text-gray-400 bg-gray-800'
                          }`}
                        >
                          {agent.isExternal ? 'external' : 'local'}
                        </span>
                        {agent.hasLegacyMembership && (
                          <span
                            className="px-1.5 py-0.5 text-xs rounded border border-amber-700 text-amber-400 bg-amber-900/20"
                            title="This agent still relies on the legacy role:agent membership fallback — issue a scoped grant to replace it."
                          >
                            legacy fallback
                          </span>
                        )}
                      </div>
                      {agent.handle && <p className="text-xs text-gray-500">@{agent.handle}</p>}
                      <p className="text-xs text-gray-600 font-mono mt-0.5 truncate">{agent.did}</p>
                      {agent.externalDid && (
                        <p className="text-xs text-gray-600 mt-1">
                          External identity: <span className="font-mono">{agent.externalDid}</span>
                        </p>
                      )}
                      {agent.createdAt && (
                        <p className="text-xs text-gray-600 mt-1">Created {formatDate(agent.createdAt)}</p>
                      )}
                    </div>

                    {agent.hasLegacyMembership && (
                      <div className="ml-3 flex-shrink-0">
                        {revokeConfirm === agent.did ? (
                          <div className="flex flex-col items-end gap-2">
                            <p className="text-xs text-red-400">Remove legacy membership?</p>
                            <div className="flex gap-2">
                              <button type="button"
                                onClick={() => handleRevokeMembership(agent.did)}
                                disabled={actionLoading === `revoke-${agent.did}`}
                                className="text-xs px-3 py-1 bg-red-700 hover:bg-red-600 text-white rounded transition disabled:opacity-50"
                              >
                                {actionLoading === `revoke-${agent.did}` ? '…' : 'Confirm'}
                              </button>
                              <button type="button"
                                onClick={() => setRevokeConfirm(null)}
                                className="text-xs px-3 py-1 border border-gray-700 text-gray-400 rounded hover:text-white transition"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button type="button"
                            onClick={() => setRevokeConfirm(agent.did)}
                            className="text-xs px-3 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition"
                          >
                            Remove legacy membership
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {agent.grants.length === 0 ? (
                    <p className="text-xs text-gray-600">
                      No grants issued yet{agent.hasLegacyMembership ? ' — this agent is currently authorized only via the legacy membership fallback.' : '.'}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {agent.grants.map((grant) => (
                        <GrantCard
                          key={grant.grantId}
                          grant={grant}
                          actionLoading={actionLoading}
                          onRevokeCapability={handleRevokeCapability}
                          onRevokeAll={handleRevokeAll}
                          onRenew={handleRenew}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
