'use client';

import { useState } from 'react';

interface JoinButtonProps {
  identityDid: string;
  viewerDid: string | null;
  initialMemberRole: string | null;
}

export function JoinButton({ identityDid, viewerDid, initialMemberRole }: JoinButtonProps) {
  const [memberRole, setMemberRole] = useState(initialMemberRole);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!viewerDid) {
    return (
      <div className="mb-6">
        <button
          disabled
          className="px-6 py-2 bg-gray-900 border border-gray-800 rounded-lg text-gray-500 text-sm cursor-not-allowed"
        >
          Sign in to join
        </button>
      </div>
    );
  }

  if (memberRole) {
    return (
      <div className="mb-6">
        <div className="px-6 py-2 bg-gray-900/50 border border-gray-800 rounded-lg text-gray-400 text-sm inline-block">
          ✓ You&apos;re a {memberRole}
        </div>
      </div>
    );
  }

  async function handleJoin() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/profile/api/stubs/${encodeURIComponent(identityDid)}/join`, {
        method: 'POST',
      });
      if (res.ok) {
        setMemberRole('member');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to join');
      }
    } catch {
      setError('Failed to join');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-6">
      <button
        onClick={handleJoin}
        disabled={loading}
        className="px-6 py-2 bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[#F59E0B] rounded-lg hover:bg-[#F59E0B]/20 transition text-sm font-medium disabled:opacity-50"
      >
        {loading ? 'Joining...' : '+ Join Community'}
      </button>
      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  );
}
