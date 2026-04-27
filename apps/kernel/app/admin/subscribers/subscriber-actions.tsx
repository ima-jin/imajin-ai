'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  id: string;
  email: string;
  isVerified: boolean;
}

export default function SubscriberActions({ id, email, isVerified }: Props) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [resending, setResending] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await fetch(`/api/admin/subscribers/${id}`, { method: 'DELETE' });
      router.refresh();
    } finally {
      setDeleting(false);
      setShowConfirm(false);
    }
  }

  async function handleResendVerify() {
    setResending(true);
    try {
      await fetch(`/api/admin/subscribers/${id}/resend-verify`, { method: 'POST' });
    } finally {
      setResending(false);
    }
  }

  if (showConfirm) {
    return (
      <div className="flex items-center gap-1 whitespace-nowrap">
        <span className="text-xs text-secondary dark:text-secondary">Delete {email}?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs text-error dark:text-error hover:underline disabled:opacity-50"
        >
          {deleting ? 'Deleting…' : 'Confirm'}
        </button>
        <button
          onClick={() => setShowConfirm(false)}
          className="text-xs text-secondary dark:text-secondary hover:underline"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      {!isVerified && (
        <button
          onClick={handleResendVerify}
          disabled={resending}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
        >
          {resending ? 'Sending…' : 'Resend verify'}
        </button>
      )}
      <button
        onClick={() => setShowConfirm(true)}
        className="text-xs text-error dark:text-error hover:underline"
      >
        Delete
      </button>
    </div>
  );
}
