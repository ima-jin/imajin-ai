'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function MarkSentButton({ id }: Readonly<{ id: string }>) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleMarkSent() {
    if (!confirm('Mark this withdrawal as sent? This cannot be undone.')) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/withdrawals/${id}/complete`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to mark as sent');
        return;
      }
      router.refresh();
    } catch (err) {
      alert('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleMarkSent}
      disabled={loading}
      className="px-3 py-1 text-xs font-medium rounded bg-green-600 hover:bg-green-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? 'Sending…' : '✅ Mark Sent'}
    </button>
  );
}
