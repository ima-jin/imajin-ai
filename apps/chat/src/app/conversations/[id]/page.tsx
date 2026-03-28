'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { Chat, ChatProvider } from '@imajin/chat';

// Inline DID parser (avoids importing Node.js crypto in client bundle)
function parseConvDid(did: string): { type: string; slug?: string } {
  const prefix = 'did:imajin:';
  if (!did.startsWith(prefix)) return { type: 'unknown' };
  const rest = did.slice(prefix.length);
  const idx = rest.indexOf(':');
  if (idx === -1) return { type: 'unknown' };
  return { type: rest.slice(0, idx), slug: rest.slice(idx + 1) || undefined };
}

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

// ─── DID-based conversation view ─────────────────────────────────────────────

function DIDConversationView({ did }: { did: string }) {
  const { identity, loading: authLoading } = useIdentity();
  const searchParams = useSearchParams();
  const [convName, setConvName] = useState<string | null>(null);
  const [nameSet, setNameSet] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [members, setMembers] = useState<{ did: string; name?: string; handle?: string; role: string }[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const parsed = parseConvDid(did);

  const handleNameSave = async () => {
    const trimmed = nameInput.trim();
    setEditingName(false);
    if (!trimmed) return;
    setConvName(trimmed); // optimistic update
    try {
      await fetch(`/api/conversations/${encodeURIComponent(did)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
    } catch {
      // ignore
    }
  };

  // Display name from URL param (e.g., when creating a group)
  const nameParam = searchParams.get('name');

  // Fetch stored conversation name
  useEffect(() => {
    if (!identity) return;
    fetch(`/api/conversations/${encodeURIComponent(did)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const conv = data?.conversation;
        if (conv?.name &&
          !conv.name.startsWith('dm:') &&
          !conv.name.startsWith('group:') &&
          !conv.name.startsWith('event:')
        ) {
          setConvName(conv.name);
          setNameSet(true);
        }
      })
      .catch(() => {});
  }, [identity, did]);

  // Fetch members for group conversations
  useEffect(() => {
    if (!identity || parsed.type !== 'group') return;
    fetch(`/api/d/${encodeURIComponent(did)}/members`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.members) {
          setMembers(data.members);
          setMemberCount(data.count);
        }
      })
      .catch(() => {});
  }, [identity, did, parsed.type]);

  // If a name was passed in the URL and we haven't stored a proper name yet,
  // save it via PATCH once the conversation exists (after the first message creates it).
  useEffect(() => {
    if (!identity || !nameParam || nameSet) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(did)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameParam }),
        });
        if (res.ok) setNameSet(true);
      } catch {
        // Ignore — the name can be set later
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [identity, nameParam, nameSet, did]);

  const chatUrl = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
  // Use same-origin proxy for access checks (cross-origin cookie forwarding is unreliable)
  const authUrl = '';  // empty = same origin, proxied via /api/access/[did]
  const mediaUrl = MEDIA_URL;

  const displayName =
    convName ||
    nameParam ||
    (parsed.type === 'dm'
      ? 'Direct Message'
      : parsed.type === 'event'
      ? 'Event Chat'
      : parsed.type === 'group'
      ? 'Group Chat'
      : 'Conversation');

  if (authLoading) {
    return <div className="max-w-2xl mx-auto mt-20 text-center text-gray-500">Loading...</div>;
  }

  if (!identity) return <LoginPrompt />;

  return (
    <div className="mx-auto flex flex-col h-[calc(100dvh-88px)]">
      {/* Header */}
      <div className="flex items-center gap-4 pb-4 border-b border-gray-200 dark:border-gray-700">
        <Link
          href="/conversations"
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
        >
          ← Back
        </Link>
        <div className="flex-1 min-w-0">
          {parsed.type === 'group' && editingName ? (
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleNameSave(); }
                if (e.key === 'Escape') setEditingName(false);
              }}
              className="font-semibold bg-transparent border-b border-orange-500 outline-none w-full text-base"
              placeholder="Untitled Group"
            />
          ) : (
            <h1
              className={`font-semibold truncate ${parsed.type === 'group' ? 'cursor-pointer hover:text-orange-500 transition-colors' : ''}`}
              onClick={() => {
                if (parsed.type === 'group') {
                  setNameInput(convName || nameParam || '');
                  setEditingName(true);
                }
              }}
              title={parsed.type === 'group' ? 'Click to rename' : undefined}
            >
              {parsed.type === 'group' && !(convName || nameParam)
                ? <span className="text-gray-400 italic font-normal">Untitled Group</span>
                : displayName}
            </h1>
          )}
          {parsed.type === 'group' && (
            <button
              onClick={() => setShowMembers(!showMembers)}
              className="text-xs text-gray-500 mt-0.5 hover:text-orange-500 transition-colors text-left"
            >
              {memberCount ? `${memberCount} member${memberCount !== 1 ? 's' : ''}` : 'Group conversation'}
            </button>
          )}
          {parsed.type === 'event' && (
            <p className="text-xs text-gray-500 mt-0.5">Event chat</p>
          )}
        </div>
      </div>

      {/* Member list panel */}
      {showMembers && members.length > 0 && (
        <div className="border-b border-gray-200 dark:border-gray-700 py-2 px-4 bg-gray-50 dark:bg-zinc-800/50">
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <span
                key={m.did}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white dark:bg-zinc-700 text-xs text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-zinc-600"
              >
                {m.role === 'owner' && <span className="text-orange-500">★</span>}
                {m.name || (m.handle ? `@${m.handle}` : m.did.slice(-8))}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Chat */}
      <div className="flex-1 overflow-hidden min-h-0">
        <ChatProvider chatUrl={chatUrl} authUrl={authUrl} mediaUrl={mediaUrl}>
          <Chat
            did={did}
            currentUserDid={identity.did}
            mediaUrl={mediaUrl}
            enableVoice
            enableMedia
            enableLocation
            className="h-full"
          />
        </ChatProvider>
      </div>
    </div>
  );
}

// ─── Page: all conversations are now DID-keyed ───────────────────────────────

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const decoded = decodeURIComponent(params.id);
  return <DIDConversationView did={decoded} />;
}
