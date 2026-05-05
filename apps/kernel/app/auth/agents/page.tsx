'use client';

import { useState, useEffect, useCallback } from 'react';

interface Agent {
  did: string;
  handle: string | null;
  displayName: string | null;
  name: string | null;
  createdAt: string | null;
  tier: string;
  status: 'online' | 'offline';
  role: string;
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

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
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
      const [agentsRes, sessionRes] = await Promise.all([
        fetch('/auth/api/agents', { credentials: 'include' }),
        fetch('/auth/api/session', { credentials: 'include' }),
      ]);

      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setAgents(data.agents || []);
      }

      if (sessionRes.ok) {
        const data = await sessionRes.json();
        setSession(data);
      } else if (sessionRes.status === 401) {
        window.location.href = '/auth/login?next=/auth/agents';
        return;
      }
    } catch (err) {
      console.error('Failed to load agents:', err);
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

  async function handleRevoke(agentDid: string) {
    setActionLoading(`revoke-${agentDid}`);
    try {
      const res = await fetch(`/auth/api/agents/${encodeURIComponent(agentDid)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        showStatus('success', 'Agent revoked successfully.');
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
              nodeUrl: 'https://jin.imajin.ai',
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
            <p className="text-gray-400 text-sm">Create and manage AI agents that act on your behalf.</p>
          </div>
          <button
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
                <label className="block text-sm text-gray-400 mb-1">Handle</label>
                <div className="flex items-center gap-2">
                  {handlePrefix && (
                    <span className="text-sm text-gray-500 shrink-0">{handlePrefix}-</span>
                  )}
                  <input
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
                <label className="block text-sm text-gray-400 mb-1">Display name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Travel Agent"
                  className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Bio</label>
                <textarea
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
                <button
                  onClick={downloadKeypair}
                  className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-black text-sm font-medium rounded-lg transition"
                >
                  Download Keypair JSON
                </button>
                <button
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
          nodeUrl: 'https://jin.imajin.ai',
          did: createdAgent.did,
          keypairPath: `/path/to/.agent-${createdAgent.handle}.json`,
        },
      },
    },
  },
}, null, 2)}
              </pre>
            </div>

            <button
              onClick={() => { setCreatedAgent(null); setShowCreateForm(false); }}
              className="text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Done
            </button>
          </div>
        )}

        {/* Agents list */}
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
            <div className="space-y-3">
              {agents.map((agent) => (
                <div
                  key={agent.did}
                  className="flex items-start justify-between p-4 bg-gray-900 rounded-xl border border-gray-800"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">🤖</span>
                      <span className="text-white font-medium">
                        {agent.displayName || agent.name || agent.handle || 'Unnamed Agent'}
                      </span>
                      <span className={`px-1.5 py-0.5 text-xs rounded border ${
                        agent.status === 'online'
                          ? 'bg-green-900/30 border-green-800 text-green-400'
                          : 'bg-gray-800 border-gray-700 text-gray-500'
                      }`}>
                        {agent.status}
                      </span>
                    </div>
                    {agent.handle && (
                      <p className="text-xs text-gray-500">@{agent.handle}</p>
                    )}
                    <p className="text-xs text-gray-600 font-mono mt-0.5 truncate">
                      {agent.did}
                    </p>
                    {agent.createdAt && (
                      <p className="text-xs text-gray-600 mt-1">
                        Created {new Date(agent.createdAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>

                  <div className="ml-3 flex-shrink-0">
                    {revokeConfirm === agent.did ? (
                      <div className="flex flex-col items-end gap-2">
                        <p className="text-xs text-red-400">Revoke this agent?</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleRevoke(agent.did)}
                            disabled={actionLoading === `revoke-${agent.did}`}
                            className="text-xs px-3 py-1 bg-red-700 hover:bg-red-600 text-white rounded transition disabled:opacity-50"
                          >
                            {actionLoading === `revoke-${agent.did}` ? '…' : 'Confirm'}
                          </button>
                          <button
                            onClick={() => setRevokeConfirm(null)}
                            className="text-xs px-3 py-1 border border-gray-700 text-gray-400 rounded hover:text-white transition"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setRevokeConfirm(agent.did)}
                        className="text-xs px-3 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
