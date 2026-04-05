'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { Chat, ChatProvider, useDidNames } from '@imajin/chat';
import { useToast } from '@imajin/ui';

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

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

interface Member {
  did: string;
  name?: string | null;
  handle?: string | null;
  role: string;
}

interface Connection {
  did: string;
  handle?: string;
  name?: string;
}

// ─── Add member picker (inside ChatProvider context for useDidNames) ──────────

function AddMemberPicker({
  connections,
  addingDid,
  loadingConnections,
  onAdd,
  onCancel,
}: {
  connections: Connection[];
  addingDid: string | null;
  loadingConnections: boolean;
  onAdd: (did: string) => void;
  onCancel: () => void;
}) {
  const didNames = useDidNames(connections.map((c) => c.did));

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">Add a member:</span>
        <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600">
          Cancel
        </button>
      </div>
      {loadingConnections ? (
        <p className="text-xs text-gray-400">Loading connections…</p>
      ) : connections.length === 0 ? (
        <p className="text-xs text-gray-400">No connections available to add.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {connections.map((conn) => {
            const label = didNames[conn.did] || (conn.handle ? `@${conn.handle}` : conn.did.slice(-8));
            return (
              <button
                key={conn.did}
                onClick={() => onAdd(conn.did)}
                disabled={addingDid === conn.did}
                className="px-2 py-1 text-xs bg-white dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 rounded-full hover:border-orange-400 hover:text-orange-500 transition disabled:opacity-50"
              >
                {addingDid === conn.did ? '…' : label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── DID-based conversation view ─────────────────────────────────────────────

function DIDConversationView({ did }: { did: string }) {
  const { identity, loading: authLoading } = useIdentity();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const [convName, setConvName] = useState<string | null>(null);
  const [nameSet, setNameSet] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [removingDid, setRemovingDid] = useState<string | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [addingDid, setAddingDid] = useState<string | null>(null);
  const parsed = parseConvDid(did);

  const callerRole = members.find((m) => m.did === identity?.did)?.role ?? null;
  const isOwnerOrAdmin = callerRole === 'owner' || callerRole === 'admin';
  const memberDidNames = useDidNames(members.map((m) => m.did));

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
  const fetchMembers = useCallback(() => {
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

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  async function handleLeave() {
    if (!identity) return;
    setLeaving(true);
    try {
      const res = await fetch(`/api/d/${encodeURIComponent(did)}/members/leave`, {
        method: 'POST',
      });
      if (res.ok) {
        toast.success('You left the group');
        router.push('/conversations');
      } else {
        toast.error('Failed to leave group');
      }
    } catch {
      toast.error('Failed to leave group');
    } finally {
      setLeaving(false);
      setLeaveConfirm(false);
    }
  }

  async function handleRemoveMember(memberDid: string) {
    setRemovingDid(memberDid);
    try {
      const res = await fetch(
        `/api/d/${encodeURIComponent(did)}/members/${encodeURIComponent(memberDid)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        toast.success('Member removed');
        fetchMembers();
      } else {
        toast.error('Failed to remove member');
      }
    } catch {
      toast.error('Failed to remove member');
    } finally {
      setRemovingDid(null);
    }
  }

  async function loadConnections() {
    if (loadingConnections || connections.length > 0) return;
    setLoadingConnections(true);
    try {
      const res = await fetch(`${connectionsUrl}/api/connections`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const memberDids = new Set(members.map((m) => m.did));

      // Deduplicate — names are resolved reactively via useDidNames in AddMemberPicker
      const seen = new Map<string, Connection>();
      for (const conn of (data.connections || []) as Connection[]) {
        if (conn.did === identity?.did) continue;
        if (memberDids.has(conn.did)) continue; // already in group
        if (!seen.has(conn.did)) seen.set(conn.did, conn);
      }

      setConnections(Array.from(seen.values()));
    } catch {
      // ignore
    } finally {
      setLoadingConnections(false);
    }
  }

  async function handleAddMember(memberDid: string) {
    setAddingDid(memberDid);
    try {
      const res = await fetch(`/api/d/${encodeURIComponent(did)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberDid }),
      });
      if (res.ok) {
        toast.success('Member added');
        setShowAddMember(false);
        setConnections([]);
        fetchMembers();
      } else {
        toast.error('Failed to add member');
      }
    } catch {
      toast.error('Failed to add member');
    } finally {
      setAddingDid(null);
    }
  }

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
  const connectionsUrl = `${SERVICE_PREFIX}connections.${DOMAIN}`;

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
    <ChatProvider chatUrl={chatUrl} authUrl={authUrl} mediaUrl={mediaUrl} connectionsUrl={connectionsUrl}>
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
        {/* Leave group button */}
        {parsed.type === 'group' && (
          leaveConfirm ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-gray-500">Leave group?</span>
              <button
                onClick={handleLeave}
                disabled={leaving}
                className="px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 transition disabled:opacity-50"
              >
                {leaving ? '…' : 'Yes, leave'}
              </button>
              <button
                onClick={() => setLeaveConfirm(false)}
                className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setLeaveConfirm(true)}
              className="shrink-0 px-3 py-1.5 text-xs text-red-500 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition"
            >
              Leave
            </button>
          )
        )}
      </div>

      {/* Member list panel */}
      {showMembers && (
        <div className="border-b border-gray-200 dark:border-gray-700 py-3 px-4 bg-gray-50 dark:bg-zinc-800/50">
          <div className="flex flex-wrap gap-2 mb-2">
            {members.map((m) => (
              <span
                key={m.did}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white dark:bg-zinc-700 text-xs text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-zinc-600"
              >
                {m.role === 'owner' && <span className="text-orange-500">★</span>}
                {memberDidNames[m.did] || m.name || (m.handle ? `@${m.handle}` : m.did.slice(-8))}
                {/* Remove button: owners can remove anyone (except self); admins can remove regular members only */}
                {isOwnerOrAdmin && m.did !== identity?.did &&
                  (callerRole === 'owner' || (m.role !== 'owner' && m.role !== 'admin')) && (
                  <button
                    onClick={() => handleRemoveMember(m.did)}
                    disabled={removingDid === m.did}
                    className="ml-1 text-gray-400 hover:text-red-500 transition disabled:opacity-50"
                    title="Remove member"
                  >
                    {removingDid === m.did ? '…' : '×'}
                  </button>
                )}
              </span>
            ))}
          </div>
          {/* Add Member */}
          {isOwnerOrAdmin && (
            showAddMember ? (
              <AddMemberPicker
                connections={connections}
                addingDid={addingDid}
                loadingConnections={loadingConnections}
                onAdd={handleAddMember}
                onCancel={() => { setShowAddMember(false); setConnections([]); }}
              />
            ) : (
              <button
                onClick={() => { setShowAddMember(true); loadConnections(); }}
                className="text-xs text-orange-500 hover:text-orange-600 transition"
              >
                + Add member
              </button>
            )
          )}
        </div>
      )}

      {/* Chat */}
      <div className="flex-1 overflow-hidden min-h-0">
        <Chat
          did={did}
          currentUserDid={identity.did}
          mediaUrl={mediaUrl}
          enableVoice
          enableMedia
          enableLocation
          className="h-full"
        />
      </div>
    </div>
    </ChatProvider>
  );
}

// ─── Page: reconstruct full DID from [type]/[slug] URL segments ───────────────

export default function ConversationPage() {
  const params = useParams<{ type: string; slug: string }>();
  const { type, slug } = params;

  // Legacy event DID format: did:imajin:evt_xxx (type segment starts with 'evt_')
  const did = type.startsWith('evt_')
    ? `did:imajin:${type}`
    : `did:imajin:${type}:${slug}`;

  return <DIDConversationView did={did} />;
}
