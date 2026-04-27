'use client';

import { useState, useEffect } from 'react';

interface MailingList {
  id: string;
  name: string;
  slug: string;
  subscriber_count: number;
}

interface Props {
  initialLists: MailingList[];
  initialConnectionCount: number;
  recentSends: Array<{
    id: string;
    subject: string;
    audience_type: string;
    audience_id: string | null;
    recipient_count: number;
    sent_at: string;
  }>;
}

export default function NewsletterComposer({ initialLists, initialConnectionCount, recentSends }: Props) {
  const [subject, setSubject] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [audienceType, setAudienceType] = useState<'newsletter' | 'connections'>('newsletter');
  const [selectedListId, setSelectedListId] = useState<string>(initialLists[0]?.id ?? '');
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ sent: boolean; recipientCount: number } | null>(null);
  const [error, setError] = useState('');

  const selectedList = initialLists.find((l) => l.id === selectedListId);

  const recipientCount =
    audienceType === 'newsletter'
      ? Number(selectedList?.subscriber_count ?? 0)
      : initialConnectionCount;

  async function handleSendTest() {
    setSendingTest(true);
    setError('');
    try {
      const res = await fetch('/api/admin/newsletter/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject,
          markdown,
          audienceType,
          audienceId: audienceType === 'newsletter' ? selectedListId : undefined,
          test: true,
          testEmail: testEmail.trim() || undefined,
          replyTo: replyTo.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Test send failed');
      else setResult({ sent: true, recipientCount: 1 });
    } finally {
      setSendingTest(false);
    }
  }

  async function handleSend() {
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/admin/newsletter/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject,
          markdown,
          audienceType,
          audienceId: audienceType === 'newsletter' ? selectedListId : undefined,
          replyTo: replyTo.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Send failed');
      else setResult({ sent: data.sent, recipientCount: data.recipientCount });
    } finally {
      setSending(false);
      setConfirm(false);
    }
  }

  function renderPreview(md: string): string {
    return md
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br/>');
  }

  const canSend = subject.trim().length > 0 && markdown.trim().length > 0 && recipientCount > 0;

  return (
    <div className="space-y-6">
      {/* Composer */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-primary mb-4 font-mono">Compose</h2>

        <div className="space-y-4">
          {/* Subject */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-primary mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Your newsletter subject…"
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-surface text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
            />
          </div>

          {/* Reply-To */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-primary mb-1">Reply-To (optional)</label>
            <input
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="ryan@imajin.ai"
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-surface text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
            />
            <p className="mt-1 text-xs text-secondary dark:text-secondary">
              Recipients who reply will send to this address instead of the default sender.
            </p>
          </div>

          {/* Body */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-gray-700 dark:text-primary">Body (Markdown)</label>
              <button
                type="button"
                onClick={() => setPreview((v) => !v)}
                className="text-xs text-imajin-orange dark:text-imajin-orange hover:underline"
              >
                {preview ? 'Edit' : 'Preview'}
              </button>
            </div>
            {preview ? (
              <div
                className="w-full min-h-48 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-surface-surface text-gray-700 dark:text-primary px-3 py-2 text-sm whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: renderPreview(markdown) }}
              />
            ) : (
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                rows={12}
                placeholder="Write your newsletter in Markdown…&#10;&#10;**Bold**, *italic*, and paragraphs are supported."
                className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-surface text-gray-900 dark:text-primary px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-imajin-purple resize-y"
              />
            )}
          </div>

          {/* Audience */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-primary mb-2">Audience</label>
            <div className="flex gap-2 mb-3">
              {(['newsletter', 'connections'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAudienceType(t)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    audienceType === t
                      ? 'bg-imajin-orange text-primary'
                      : 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated'
                  }`}
                >
                  {t === 'newsletter' ? 'Newsletter' : 'Connections'}
                </button>
              ))}
            </div>

            {audienceType === 'newsletter' ? (
              <div className="flex items-center gap-2">
                <select
                  value={selectedListId}
                  onChange={(e) => setSelectedListId(e.target.value)}
                  className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
                >
                  {initialLists.length === 0 && (
                    <option value="">No lists available</option>
                  )}
                  {initialLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({Number(l.subscriber_count).toLocaleString()} subscribers)
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-sm text-secondary dark:text-secondary">
                Send to all {initialConnectionCount.toLocaleString()} connection{initialConnectionCount !== 1 ? 's' : ''} with a contact email.
              </p>
            )}

            <p className="mt-2 text-sm font-medium text-gray-900 dark:text-primary">
              Recipients:{' '}
              <span className="text-imajin-orange dark:text-imajin-orange">
                {recipientCount.toLocaleString()}
              </span>
            </p>
          </div>

          {error && <p className="text-sm text-error dark:text-error">{error}</p>}

          {result && (
            <p className="text-sm text-success dark:text-success">
              {result.sent
                ? `Sent to ${result.recipientCount.toLocaleString()} recipient${result.recipientCount !== 1 ? 's' : ''}.`
                : 'No recipients found.'}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <input
              type="email"
              placeholder="Test email address"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              className="w-56 px-3 py-1.5 border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-sm text-gray-900 dark:text-primary focus:outline-none focus:ring-2 focus:ring-imajin-purple/50"
            />
            <button
              type="button"
              onClick={handleSendTest}
              disabled={sendingTest || !subject.trim() || !markdown.trim()}
              className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sendingTest ? 'Sending test…' : 'Send Test'}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(true)}
              disabled={sending || !canSend}
              style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-4 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : 'Send Newsletter'}
            </button>
          </div>
        </div>
      </div>

      {/* Confirm dialog */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-base/50">
          <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6 w-full max-w-sm">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-primary mb-2 font-mono">Confirm Send</h3>
            <p className="text-sm text-muted dark:text-primary mb-4">
              This will send <strong>"{subject}"</strong> to{' '}
              <strong>{recipientCount.toLocaleString()} recipient{recipientCount !== 1 ? 's' : ''}</strong>.
              This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirm(false)}
                className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending}
                style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                {sending ? 'Sending…' : `Send to ${recipientCount.toLocaleString()}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send History */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-white/10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-primary font-mono">Send History</h2>
        </div>
        {recentSends.length === 0 ? (
          <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">No sends yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Subject</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Audience</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Recipients</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {recentSends.map((send) => (
                  <tr key={send.id} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40 transition-colors">
                    <td className="px-4 py-3 text-gray-700 dark:text-primary max-w-xs truncate">{send.subject}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary px-2 py-0.5 ">
                        {send.audience_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-primary">
                      {Number(send.recipient_count).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap">
                      {send.sent_at ? new Date(send.sent_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
