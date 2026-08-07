'use client';

import { useId, useState } from 'react';

/**
 * Delete-conversation control (#1651).
 *
 * Rendering is the caller's decision — mount this only when
 * `canDeleteConversation()` is true, so a non-creator never sees a control the
 * API would answer with a 403. The component owns the destructive half of the
 * flow: confirm, call `DELETE /chat/api/conversations/:id`, report the outcome.
 *
 * The delete cascades to messages, reactions and read markers for *everyone* in
 * the conversation, so the confirmation is a modal the user has to answer rather
 * than an inline toggle that a stray click can dismiss into a delete.
 *
 * No toast here: the conversations list renders outside a `ToastProvider`, and
 * `useToast()` throws without one. Callers that have a provider pass `onError`.
 */
export interface DeleteConversationButtonProps {
  /** Conversation DID, sent URL-encoded to the API. */
  did: string;
  /** Human-readable name, quoted in the confirmation copy when known. */
  name?: string;
  /** Called once the API confirms the delete. */
  onDeleted: (did: string) => void;
  /** Called with a user-facing message when the delete fails. */
  onError?: (message: string) => void;
  /** Extra classes for the trigger button. */
  className?: string;
}

const DEFAULT_TRIGGER_CLASS =
  'px-3 py-1.5 text-xs text-red-500 border border-red-200 dark:border-red-800 ' +
  'rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50';

const GENERIC_FAILURE = 'Failed to delete conversation';

function failureMessage(status: number): string {
  if (status === 403) return 'Only the creator can delete this conversation';
  if (status === 404) return 'Conversation not found';
  return GENERIC_FAILURE;
}

export function DeleteConversationButton({
  did,
  name,
  onDeleted,
  onError,
  className,
}: Readonly<DeleteConversationButtonProps>) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  function fail(message: string) {
    setError(message);
    onError?.(message);
  }

  function openDialog() {
    setError(null);
    setConfirming(true);
  }

  function closeDialog() {
    setConfirming(false);
    setError(null);
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/chat/api/conversations/${encodeURIComponent(did)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        fail(failureMessage(res.status));
        return;
      }
      setConfirming(false);
      onDeleted(did);
    } catch {
      fail(GENERIC_FAILURE);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        aria-label={name ? `Delete conversation ${name}` : 'Delete conversation'}
        className={className ?? DEFAULT_TRIGGER_CLASS}
      >
        Delete
      </button>

      {confirming && (
        <dialog
          open
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="fixed inset-0 z-50 m-0 flex h-full max-h-full w-full max-w-full items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm rounded-xl bg-white p-6 text-left shadow-2xl dark:bg-gray-800">
            <h2 id={titleId} className="text-lg font-bold text-gray-900 dark:text-white">
              Delete conversation?
            </h2>
            <p id={descriptionId} className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {name ? `“${name}” and all` : 'All'} of its messages, reactions and read
              markers will be permanently deleted for everyone. This cannot be undone.
            </p>

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400"
              >
                {error}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={deleting}
                className="rounded-lg bg-gray-100 px-3 py-1.5 text-sm transition hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-700 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}
