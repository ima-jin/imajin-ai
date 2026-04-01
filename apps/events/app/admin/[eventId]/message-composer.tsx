'use client';

import { useState } from 'react';

interface MessageComposerProps {
  eventId: string;
  recipientCount: number;
}

export function MessageComposer({ eventId, recipientCount }: MessageComposerProps) {
  const [subject, setSubject] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [preview, setPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; skipped: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSendClick() {
    if (!subject.trim() || !markdown.trim()) return;
    setConfirming(true);
  }

  async function handleConfirm() {
    setConfirming(false);
    setSending(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/events/${eventId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), markdown: markdown.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to send message');
      } else {
        setResult(data);
        setSubject('');
        setMarkdown('');
        setPreview(false);
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setSending(false);
    }
  }

  // Simple markdown → HTML preview (basic rendering for the composer)
  function renderPreview(md: string): string {
    return md
      .replace(/^### (.+)$/gm, '<h3 style="font-size:1rem;font-weight:600;margin:0.75em 0 0.25em">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="font-size:1.125rem;font-weight:700;margin:1em 0 0.25em">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="font-size:1.25rem;font-weight:700;margin:1em 0 0.5em">$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#f97316">$1</a>')
      .replace(/^- (.+)$/gm, '<li style="margin-left:1.25em">$1</li>')
      .replace(/\n\n/g, '</p><p style="margin:0.5em 0">')
      .replace(/^(?!<[h1-6li])(.+)$/gm, '<p style="margin:0.5em 0">$1</p>');
  }

  const canSend = subject.trim().length > 0 && markdown.trim().length > 0 && !sending;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        {/* Mail icon */}
        <svg className="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <h2 className="text-xl font-semibold">Message Attendees</h2>
        <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">
          {recipientCount} recipient{recipientCount !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow space-y-4">
        {/* Subject */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Subject
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Your message subject"
            className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent text-sm"
          />
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPreview(false)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              !preview
                ? 'bg-orange-500 text-white'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            Write
          </button>
          <button
            type="button"
            onClick={() => setPreview(true)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              preview
                ? 'bg-orange-500 text-white'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            Preview
          </button>
        </div>

        {/* Editor / Preview */}
        {preview ? (
          <div
            className="min-h-[160px] px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 prose dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: markdown.trim() ? renderPreview(markdown) : '<span class="text-gray-400">Nothing to preview</span>' }}
          />
        ) : (
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder="Write your message in markdown..."
            rows={8}
            className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent text-sm font-mono resize-y"
          />
        )}

        {/* Success */}
        {result && (
          <div className="rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-4 py-3 text-sm text-green-800 dark:text-green-300">
            Message sent — {result.sent} delivered, {result.skipped} skipped{result.errors > 0 ? `, ${result.errors} errors` : ''}.
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-800 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Send button */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSendClick}
            disabled={!canSend}
            className="px-5 py-2 rounded-md bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {sending ? 'Sending…' : `Send to ${recipientCount} attendee${recipientCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>

      {/* Confirmation dialog */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Send this message?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              This will send <strong>"{subject}"</strong> to{' '}
              <strong>{recipientCount} attendee{recipientCount !== 1 ? 's' : ''}</strong>. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="px-4 py-2 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
