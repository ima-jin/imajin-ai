'use client';

import { useState } from 'react';

interface FollowButtonProps {
  targetDid: string;
  initialFollowing: boolean;
}

export function FollowButton({ targetDid, initialFollowing }: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing);
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/follow', {
        method: following ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: targetDid }),
      });
      if (res.ok) {
        setFollowing(!following);
      }
    } catch (error) {
      console.error('Follow action failed:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`px-4 py-2 rounded-lg border transition text-sm font-medium disabled:opacity-50 ${
        following
          ? 'bg-gray-900 border-gray-700 text-gray-300 hover:border-red-700 hover:text-red-400'
          : 'bg-[#F59E0B]/10 border-[#F59E0B]/30 text-[#F59E0B] hover:bg-[#F59E0B]/20'
      }`}
    >
      {loading ? '...' : following ? 'Following' : 'Follow'}
    </button>
  );
}
