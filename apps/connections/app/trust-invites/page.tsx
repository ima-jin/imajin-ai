'use client';

import { useState, useEffect } from 'react';
import { useIdentity } from '../context/IdentityContext';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const AUTH_URL = `${SERVICE_PREFIX}auth.${DOMAIN}`;
const PROFILE_URL = `${SERVICE_PREFIX}profile.${DOMAIN}`;

interface TrustInvite {
  id: string;
  inviterDid: string;
  inviteeEmail?: string;
  inviteeDid?: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  createdAt: string;
  acceptedAt?: string;
  expiresAt: string;
}

interface InviteLists {
  sent: TrustInvite[];
  received: TrustInvite[];
}

export default function TrustInvitesPage() {
  const { did, handle, isLoggedIn, loading } = useIdentity();
  const [invites, setInvites] = useState<InviteLists>({ sent: [], received: [] });
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownInfo, setCooldownInfo] = useState<{ nextAvailableAt?: string } | null>(null);

  useEffect(() => {
    if (isLoggedIn) {
      fetchInvites();
    }
  }, [isLoggedIn]);

  async function fetchInvites() {
    try {
      const res = await fetch('/api/trust-invites');
      if (res.ok) {
        const data = await res.json();
        setInvites(data);
      }
    } catch (err) {
      console.error('Failed to fetch invites:', err);
    }
  }

  async function createInvite() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/trust-invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail || undefined }),
      });
      const data = await res.json();

      if (res.ok) {
        setInviteEmail('');
        setShowInviteForm(false);
        fetchInvites();
      } else {
        setError(data.error || 'Failed to create invite');
        if (data.nextAvailableAt) {
          setCooldownInfo({ nextAvailableAt: data.nextAvailableAt });
        }
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  async function revokeInvite(id: string) {
    try {
      const res = await fetch(`/api/trust-invites/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchInvites();
      }
    } catch (err) {
      console.error('Failed to revoke invite:', err);
    }
  }

  async function acceptInvite(id: string) {
    try {
      const res = await fetch(`/api/trust-invites/${id}/accept`, { method: 'POST' });
      const data = await res.json();

      if (res.ok) {
        alert(data.message || 'Invite accepted!');
        fetchInvites();
      } else {
        alert(data.error || 'Failed to accept invite');
      }
    } catch (err) {
      alert('Network error. Please try again.');
    }
  }

  function formatTimeRemaining(expiresAt: string): string {
    const now = new Date();
    const expires = new Date(expiresAt);
    const diffMs = expires.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
    if (diffHours > 0) return `${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
    return 'Soon';
  }

  function formatCooldown(nextAvailableAt: string): string {
    const now = new Date();
    const next = new Date(nextAvailableAt);
    const diffMs = next.getTime() - now.getTime();
    const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
    const diffDays = Math.ceil(diffHours / 24);

    if (diffDays > 1) return `${diffDays} days`;
    if (diffHours > 1) return `${diffHours} hours`;
    return 'less than 1 hour';
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">🔐</div>
        <h1 className="text-3xl font-bold mb-3">Trust Graph Invites</h1>
        <p className="text-gray-400 mb-8">Sign in to manage your trust graph invitations.</p>
        <a
          href={`${PROFILE_URL}/login?next=${encodeURIComponent(`${SERVICE_PREFIX}connections.${DOMAIN}/trust-invites`)}`}
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

  const pendingSent = invites.sent.filter(i => i.status === 'pending');
  const completedSent = invites.sent.filter(i => i.status !== 'pending');
  const pendingReceived = invites.received.filter(i => i.status === 'pending');
  const completedReceived = invites.received.filter(i => i.status !== 'pending');

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Trust Graph Invites</h1>
          <p className="text-gray-400 text-sm mt-1">
            Controlled invite system with 7-day cooldown
          </p>
        </div>
        <button
          onClick={() => setShowInviteForm(!showInviteForm)}
          disabled={pendingSent.length > 0}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-medium rounded-lg transition"
          title={pendingSent.length > 0 ? 'You have a pending invite' : 'Create new invite'}
        >
          + Invite Someone
        </button>
      </div>

      {/* Invite Form */}
      {showInviteForm && (
        <div className="mb-8 p-6 bg-white/5 border border-amber-500/30 rounded-lg">
          <h3 className="text-lg font-semibold mb-3">Create Trust Graph Invite</h3>
          <p className="text-sm text-gray-400 mb-4">
            Send an invite to someone you trust. You can only have one pending invite at a time.
            After acceptance, you'll have a 7-day cooldown before you can send another invite.
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              {error}
              {cooldownInfo?.nextAvailableAt && (
                <div className="mt-1 text-xs">
                  Next invite available in {formatCooldown(cooldownInfo.nextAvailableAt)}
                </div>
              )}
            </div>
          )}

          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="Email address (optional - can also invite by DID)"
            className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-gray-500 text-sm mb-3"
          />
          <div className="flex gap-2">
            <button
              onClick={createInvite}
              disabled={creating}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg transition"
            >
              {creating ? 'Creating...' : 'Send Invite'}
            </button>
            <button
              onClick={() => {
                setShowInviteForm(false);
                setError(null);
              }}
              className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Received Invites */}
      {pendingReceived.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">📬 Received Invites</h2>
          <div className="space-y-3">
            {pendingReceived.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-4 p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium">
                    Invite from {inv.inviterDid.slice(0, 24)}...
                  </div>
                  <div className="text-gray-400 text-xs mt-1">
                    Expires in {formatTimeRemaining(inv.expiresAt)}
                  </div>
                </div>
                <button
                  onClick={() => acceptInvite(inv.id)}
                  className="px-4 py-2 text-sm bg-green-500 hover:bg-green-600 text-white rounded-lg transition"
                >
                  Accept
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sent Invites */}
      {pendingSent.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">📤 Pending Sent Invite</h2>
          <div className="space-y-3">
            {pendingSent.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white">
                    {inv.inviteeEmail || (inv.inviteeDid ? `DID: ${inv.inviteeDid.slice(0, 24)}...` : 'General invite')}
                  </div>
                  <div className="text-gray-400 text-xs mt-1">
                    Sent {new Date(inv.createdAt).toLocaleDateString()} · Expires in {formatTimeRemaining(inv.expiresAt)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (confirm('Revoke this invite? This will free your invite slot immediately.')) {
                      revokeInvite(inv.id);
                    }
                  }}
                  className="px-3 py-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invite History */}
      {(completedSent.length > 0 || completedReceived.length > 0) && (
        <div>
          <h2 className="text-xl font-semibold mb-4">History</h2>
          <div className="space-y-2">
            {completedSent.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-4 p-3 bg-white/5 border border-white/10 rounded-lg opacity-60"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-300">
                    Sent to {inv.inviteeEmail || (inv.inviteeDid ? inv.inviteeDid.slice(0, 24) + '...' : 'unknown')}
                  </div>
                  <div className="text-gray-500 text-xs mt-1">
                    {inv.status === 'accepted' && `✓ Accepted ${new Date(inv.acceptedAt!).toLocaleDateString()}`}
                    {inv.status === 'expired' && '⏰ Expired'}
                    {inv.status === 'revoked' && '🚫 Revoked'}
                  </div>
                </div>
              </div>
            ))}
            {completedReceived.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-4 p-3 bg-white/5 border border-white/10 rounded-lg opacity-60"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-300">
                    Received from {inv.inviterDid.slice(0, 24)}...
                  </div>
                  <div className="text-gray-500 text-xs mt-1">
                    {inv.status === 'accepted' && `✓ Accepted ${new Date(inv.acceptedAt!).toLocaleDateString()}`}
                    {inv.status === 'expired' && '⏰ Expired'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {invites.sent.length === 0 && invites.received.length === 0 && (
        <div className="text-center py-12 bg-white/5 border border-white/10 rounded-lg">
          <div className="text-4xl mb-3">📨</div>
          <p className="text-gray-400">No invites yet. Create your first invite to grow your trust graph!</p>
        </div>
      )}
    </div>
  );
}
