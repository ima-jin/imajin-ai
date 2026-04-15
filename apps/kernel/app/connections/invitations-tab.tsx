'use client';

import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useToast } from '@imajin/ui';

import { buildPublicUrl } from '@imajin/config';

const PROFILE_URL = buildPublicUrl('profile');

interface InvitedBy {
  did: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  date: string | null;
}

interface SentInvite {
  id: string;
  code: string;
  toEmail: string | null;
  toDid: string | null;
  note: string | null;
  delivery: 'link' | 'email';
  status: string;
  usedCount: number;
  maxUses: number;
  createdAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  acceptedHandle: string | null;
  daysAgo: number;
  url: string;
}

interface Quota {
  tier: string;
  limit: number | null;
  pending: number;
  remaining: number | null;
}

function formatDate(iso: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    pending: 'bg-yellow-500/20 text-yellow-300',
    accepted: 'bg-green-500/20 text-green-300',
    expired: 'bg-gray-500/20 text-gray-400',
    revoked: 'bg-red-500/20 text-red-400',
    used: 'bg-green-500/20 text-green-300',
  };
  return (
    <span className={`px-1.5 py-0.5 text-xs rounded-full font-medium shrink-0 ${styles[status] || 'bg-white/10 text-gray-400'}`}>
      {status}
    </span>
  );
}

export default function InvitationsTab({ onCountUpdate }: { onCountUpdate?: (pending: number, remaining: number | null) => void }) {
  const { toast } = useToast();
  const [invitedBy, setInvitedBy] = useState<InvitedBy | null | 'loading'>('loading');
  const [sentInvites, setSentInvites] = useState<SentInvite[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [activeCreate, setActiveCreate] = useState<null | 'link' | 'email'>(null);
  const [inviteNote, setInviteNote] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [showAccepted, setShowAccepted] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<{ url: string; code: string } | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailResult, setEmailResult] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    await Promise.all([fetchInvitedBy(), fetchSentInvites()]);
  }

  async function fetchInvitedBy() {
    try {
      const res = await fetch('/connections/api/invites/invited-by');
      if (res.ok) {
        const data = await res.json();
        setInvitedBy(data.invitedBy ?? null);
      } else {
        setInvitedBy(null);
      }
    } catch {
      setInvitedBy(null);
    }
  }

  async function fetchSentInvites() {
    try {
      const res = await fetch('/connections/api/invites');
      if (res.ok) {
        const data = await res.json();
        setSentInvites(data.invites || []);
        const q = {
          tier: data.tier || data.role || 'unknown',
          limit: data.limit,
          pending: data.pending,
          remaining: data.remaining,
        };
        setQuota(q);
        onCountUpdate?.(q.pending, q.remaining);
      }
    } catch {}
  }

  async function generateLink() {
    setGenerating(true);
    setGeneratedInvite(null);
    try {
      const res = await fetch('/connections/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: inviteNote || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        setGeneratedInvite({ url: data.url, code: data.invite.code });
        setInviteNote('');
        fetchSentInvites();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to generate invite');
      }
    } catch {} finally {
      setGenerating(false);
    }
  }

  async function sendEmailInvite() {
    if (!inviteEmail.trim()) return;
    setSendingEmail(true);
    setEmailResult(null);
    try {
      const res = await fetch('/connections/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery: 'email', toEmail: inviteEmail.trim(), note: emailNote || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setEmailResult('success');
        setInviteEmail('');
        setEmailNote('');
        fetchSentInvites();
      } else {
        setEmailResult(data.error || 'Failed to send invite');
        // If it's a pending invite issue, refresh the list
        if (data.pendingInvite) fetchSentInvites();
      }
    } catch {
      setEmailResult('An error occurred');
    } finally {
      setSendingEmail(false);
    }
  }

  async function deleteInvite(code: string) {
    try {
      await fetch(`/connections/api/invites/${code}`, { method: 'DELETE' });
      fetchSentInvites();
    } catch {}
  }

  function copyLink(url: string, code: string) {
    navigator.clipboard.writeText(url);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  const allSentRows = sentInvites
    .map((inv) => ({
      key: inv.id,
      type: inv.delivery,
      recipient: inv.toEmail || inv.code.slice(0, 12) + '…',
      status: inv.status,
      note: inv.note || null,
      date: inv.createdAt,
      acceptedDate: inv.acceptedAt || null,
      acceptedBy: inv.acceptedBy || null,
      acceptedHandle: inv.acceptedHandle || null,
      acceptedDid: inv.toDid || null,
      url: inv.url,
      code: inv.code,
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return (
    <div className="space-y-8">
      {/* ─── QR Code Fullscreen Overlay ─── */}
      {qrUrl && (
        <div
          className="fixed inset-0 z-[9999] bg-white flex items-center justify-center cursor-pointer"
          onClick={() => setQrUrl(null)}
        >
          <div className="flex flex-col items-center gap-6 p-8 max-w-[90vmin]">
            <QRCodeSVG
              value={qrUrl}
              size={Math.min(typeof window !== 'undefined' ? window.innerWidth * 0.8 : 320, typeof window !== 'undefined' ? window.innerHeight * 0.7 : 320, 512)}
              level="M"
              includeMargin
              bgColor="#ffffff"
              fgColor="#000000"
            />
            <div className="text-center">
              <div className="text-black/80 text-sm font-medium mb-1">Scan to connect on Imajin</div>
              <div className="text-black/40 text-xs">Tap anywhere to close</div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Section A: Invited by ─── */}
      {invitedBy !== 'loading' && invitedBy !== null && (
        <div className="p-4 bg-white/5 border border-white/10 rounded-lg flex items-center gap-3">
          <span className="text-xl">🌱</span>
          <div className="text-sm text-gray-300">
            Invited by{' '}
            {invitedBy.handle ? (
              <a
                href={`${PROFILE_URL}/${invitedBy.handle}`}
                className="text-amber-400 hover:text-amber-300 font-medium transition"
              >
                @{invitedBy.handle}
              </a>
            ) : (
              <a
                href={`${PROFILE_URL}/${invitedBy.did}`}
                className="text-amber-400 hover:text-amber-300 font-medium transition"
              >
                {invitedBy.name || invitedBy.did.slice(0, 20) + '…'}
              </a>
            )}
            {invitedBy.date && (
              <span className="text-gray-500"> · {formatDate(invitedBy.date)}</span>
            )}
          </div>
        </div>
      )}

      {invitedBy !== 'loading' && invitedBy === null && (
        <div className="p-4 bg-white/5 border border-white/10 rounded-lg flex items-center gap-3">
          <span className="text-xl">🌱</span>
          <span className="text-sm text-gray-300">Founding member</span>
        </div>
      )}

      {/* ─── Section B: Create Invite ─── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create Invite</h2>
          {quota && (
            <span className="text-xs text-gray-400">
              {quota.remaining === null
                ? `${quota.pending} pending · unlimited`
                : `${quota.remaining} remaining · ${quota.pending} pending`}
              <span className="ml-1 text-gray-600">({quota.tier})</span>
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            onClick={() => {
              setActiveCreate(activeCreate === 'link' ? null : 'link');
              setGeneratedInvite(null);
            }}
            className={`p-4 rounded-lg border text-left transition ${
              activeCreate === 'link'
                ? 'border-amber-500/50 bg-amber-500/10 text-white'
                : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
            }`}
          >
            <div className="text-xl mb-1">🔗</div>
            <div className="text-sm font-medium">Generate Link</div>
            <div className="text-xs text-gray-500 mt-0.5">Share a one-time invite URL</div>
          </button>
          <button
            onClick={() => {
              setActiveCreate(activeCreate === 'email' ? null : 'email');
              setEmailResult(null);
            }}
            className={`p-4 rounded-lg border text-left transition ${
              activeCreate === 'email'
                ? 'border-amber-500/50 bg-amber-500/10 text-white'
                : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
            }`}
          >
            <div className="text-xl mb-1">📧</div>
            <div className="text-sm font-medium">Email Invite</div>
            <div className="text-xs text-gray-500 mt-0.5">Send directly via email</div>
          </button>
        </div>

        {/* Generate Link panel */}
        {activeCreate === 'link' && (
          <div className="p-5 bg-white/5 border border-amber-500/20 rounded-lg">
            {generatedInvite ? (
              <div>
                <p className="text-sm text-gray-400 mb-3">Share this link with someone you trust:</p>
                <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2 mb-3">
                  <code className="text-xs text-amber-300 flex-1 truncate">{generatedInvite.url}</code>
                  <button
                    onClick={() => setQrUrl(generatedInvite.url)}
                    className="px-2.5 py-1 text-xs bg-white/10 hover:bg-white/20 text-white font-medium rounded transition shrink-0"
                    title="Show QR code"
                  >
                    QR
                  </button>
                  <button
                    onClick={() => copyLink(generatedInvite.url, generatedInvite.code)}
                    className="px-2.5 py-1 text-xs bg-amber-500 hover:bg-amber-600 text-black font-medium rounded transition shrink-0"
                  >
                    {copiedCode === generatedInvite.code ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <button
                  onClick={() => { setGeneratedInvite(null); setInviteNote(''); }}
                  className="text-xs text-gray-500 hover:text-gray-300 transition"
                >
                  Generate another
                </button>
              </div>
            ) : (
              <div>
                <textarea
                  value={inviteNote}
                  onChange={(e) => setInviteNote(e.target.value)}
                  placeholder="Add a personal note (optional)"
                  className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-gray-500 text-sm resize-none mb-3"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={generateLink}
                    disabled={generating}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg transition text-sm"
                  >
                    {generating ? 'Generating…' : 'Generate Link'}
                  </button>
                  <button
                    onClick={() => setActiveCreate(null)}
                    className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Email Invite panel */}
        {activeCreate === 'email' && (
          <div className="p-5 bg-white/5 border border-amber-500/20 rounded-lg">
            {quota && quota.remaining !== null && quota.remaining <= 0 &&
              sentInvites.some(i => i.delivery === 'email' && i.status === 'pending') && (
              <div className="mb-3 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-xs text-yellow-300">
                ⚠️ Invite limit reached. Pending email invites must be accepted, expired, or revoked before you can send more.
              </div>
            )}
            {emailResult === 'success' ? (
              <div>
                <p className="text-sm text-green-400 mb-3">✓ Invite sent successfully!</p>
                <button
                  onClick={() => { setEmailResult(null); }}
                  className="text-xs text-gray-500 hover:text-gray-300 transition"
                >
                  Send another
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="Email address"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm mb-3"
                  onKeyDown={(e) => e.key === 'Enter' && sendEmailInvite()}
                />
                <textarea
                  value={emailNote}
                  onChange={(e) => setEmailNote(e.target.value)}
                  placeholder="Add a personal message (optional)"
                  className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-gray-500 text-sm resize-none mb-3"
                  rows={2}
                />
                {emailResult && emailResult !== 'success' && (
                  <p className="text-xs text-red-400 mb-3">{emailResult}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={sendEmailInvite}
                    disabled={sendingEmail || !inviteEmail.trim()}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg transition text-sm"
                  >
                    {sendingEmail ? 'Sending…' : 'Send Invite'}
                  </button>
                  <button
                    onClick={() => setActiveCreate(null)}
                    className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Section C: Sent Invites ─── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Sent Invites</h2>
          {allSentRows.some(r => r.status === 'accepted') && (
            <button
              onClick={() => setShowAccepted(!showAccepted)}
              className="text-xs text-gray-500 hover:text-gray-300 transition"
            >
              {showAccepted ? 'Hide accepted' : 'Show accepted'}
            </button>
          )}
        </div>
        {allSentRows.length === 0 ? (
          <div className="text-center py-10 bg-white/5 border border-white/10 rounded-lg">
            <div className="text-3xl mb-2">📨</div>
            <p className="text-gray-400 text-sm">No invites sent yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {allSentRows.filter(r => showAccepted || r.status !== "accepted").map((row) => (
              <div
                key={row.key}
                className="flex items-center gap-3 p-3.5 bg-white/5 border border-white/10 rounded-lg"
              >
                <span className="text-base shrink-0">{row.type === 'link' ? '🔗' : '📧'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-200 truncate">
                    {row.status === 'accepted' && row.acceptedHandle ? (
                      <a
                        href={`${PROFILE_URL}/${row.acceptedHandle}`}
                        className="text-amber-400 hover:text-amber-300 transition"
                      >
                        @{row.acceptedHandle}
                      </a>
                    ) : row.status === 'accepted' && row.acceptedBy ? (
                      row.acceptedDid ? (
                        <a
                          href={`${PROFILE_URL}/${row.acceptedDid}`}
                          className="text-amber-400 hover:text-amber-300 transition"
                        >
                          {row.acceptedBy}
                        </a>
                      ) : (
                        <span>{row.acceptedBy}</span>
                      )
                    ) : (
                      row.recipient
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {formatDate(row.date)}
                    {row.acceptedDate && (
                      <span className="text-green-500"> · accepted {formatDate(row.acceptedDate)}</span>
                    )}
                  </div>
                  {row.note && (
                    <div className="text-xs text-gray-500 mt-1 italic">&ldquo;{row.note}&rdquo;</div>
                  )}
                </div>
                {statusBadge(row.status)}
                {row.status === 'pending' && row.url && row.code && (
                  <>
                    {row.type === 'link' && (
                      <>
                        <button
                          onClick={() => setQrUrl(row.url!)}
                          className="px-2.5 py-1 text-xs bg-white/10 hover:bg-white/15 text-white rounded transition shrink-0"
                          title="Show QR code"
                        >
                          QR
                        </button>
                        <button
                          onClick={() => copyLink(row.url!, row.code!)}
                          className="px-2.5 py-1 text-xs bg-white/10 hover:bg-white/15 text-white rounded transition shrink-0"
                        >
                          {copiedCode === row.code ? '✓' : 'Copy'}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => deleteInvite(row.code!)}
                      className="px-2.5 py-1 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded transition shrink-0"
                    >
                      {row.type === 'email' ? 'Revoke' : 'Delete'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
