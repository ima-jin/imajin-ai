'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { useWebSocket } from '@/hooks/useWebSocket';
import { MessageBubble, Chat, ChatProvider, VoiceRecorder } from '@imajin/chat';
import { TypingIndicator } from '@/app/components/TypingIndicator';
import { FileUpload } from '@/app/components/FileUpload';
import { LocationPicker, LocationData } from '@/app/components/LocationPicker';
import { sendVoiceMessage } from '@/lib/voice';

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
      await fetch('/api/conversations-v2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did, name: trimmed }),
      });
    } catch {
      // ignore
    }
  };

  // Display name from URL param (e.g., when creating a group)
  const nameParam = searchParams.get('name');

  // Fetch stored conversation name from v2 API
  useEffect(() => {
    if (!identity) return;
    fetch(`/api/conversations-v2?did=${encodeURIComponent(did)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const conv = data?.conversations?.[0];
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
  // We use a short delay to give the auto-create time to run.
  useEffect(() => {
    if (!identity || !nameParam || nameSet) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/conversations-v2', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ did, name: nameParam }),
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
  const inputUrl = process.env.NEXT_PUBLIC_INPUT_URL || 'http://localhost:3008';
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
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-200px)]">
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
        <ChatProvider chatUrl={chatUrl} authUrl={authUrl} inputUrl={inputUrl} mediaUrl={mediaUrl}>
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

// ─── Legacy conversation view (conv_xxx) ─────────────────────────────────────

interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

interface Message {
  id: string;
  conversationId: string;
  fromDid: string;
  content: { type: string; text: string };
  contentType: string;
  replyTo: string | null;
  linkPreviews?: LinkPreview[] | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  mediaType?: 'image' | 'file' | null;
  mediaPath?: string | null;
  mediaMeta?: unknown;
}

interface ConversationInfo {
  id: string;
  type: string;
  name: string | null;
  createdBy: string;
  podName?: string | null;
  eventName?: string | null;
  participantCount?: number;
}

interface Reaction {
  emoji: string;
  count: number;
  reacted: boolean;
}

function formatDateDivider(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function LegacyConversationView({ conversationId }: { conversationId: string }) {
  const { identity, loading: authLoading } = useIdentity();
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [message, setMessage] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handleMap, setHandleMap] = useState<Record<string, string>>({});
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, Reaction[]>>({});
  const [typingUsers, setTypingUsers] = useState<Array<{ did: string; name: string | null }>>([]);
  const [uploadedMedia, setUploadedMedia] = useState<{
    mediaType: 'image' | 'file';
    mediaPath: string;
    mediaMeta: unknown;
  } | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set(['send:text']));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef<number>(0);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const {
    lastMessage: wsMessage,
    isConnected: wsConnected,
    subscribe: wsSubscribe,
    sendTyping,
    sendStopTyping,
  } = useWebSocket();

  useEffect(() => {
    if (!identity) return;
    async function fetchCapabilities() {
      try {
        const res = await fetch('/api/capabilities');
        if (res.ok) {
          const data = await res.json();
          setCapabilities(new Set(data.capabilities));
        }
      } catch {
        // Silently fail
      }
    }
    fetchCapabilities();
  }, [identity]);

  useEffect(() => {
    if (!identity || !conversationId) return;

    async function fetchConversation() {
      try {
        const res = await fetch(`/api/conversations/${conversationId}`);
        if (res.ok) {
          const data = await res.json();
          setConversation(data.conversation || data);
        }
      } catch {
        // Optional
      }
    }

    async function markAsRead() {
      try {
        await fetch(`/api/conversations/${conversationId}/read`, { method: 'POST' });
      } catch {
        // Silently fail
      }
    }

    fetchConversation();
    markAsRead();

    const handleFocus = () => markAsRead();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [identity, conversationId]);

  useEffect(() => {
    if (!messages.length) return;
    const unknownDids = Array.from(new Set(messages.map((m) => m.fromDid))).filter(
      (d) => !handleMap[d]
    );
    if (!unknownDids.length) return;

    unknownDids.forEach(async (did) => {
      try {
        const res = await fetch(`/api/lookup/${encodeURIComponent(did)}`);
        if (res.ok) {
          const data = await res.json();
          const label = data.handle ? `@${data.handle}` : data.name || did.slice(0, 16) + '...';
          setHandleMap((prev) => ({ ...prev, [did]: label }));
        } else {
          setHandleMap((prev) => ({ ...prev, [did]: did.slice(0, 16) + '...' }));
        }
      } catch {
        setHandleMap((prev) => ({ ...prev, [did]: did.slice(0, 16) + '...' }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (!identity || !messages.length) return;

    messages.forEach(async (msg) => {
      if (msg.deletedAt) return;
      try {
        const res = await fetch(`/api/messages/${msg.id}/reactions`);
        if (res.ok) {
          const data = await res.json();
          setMessageReactions((prev) => ({ ...prev, [msg.id]: data.reactions || [] }));
        }
      } catch {
        // Ignore
      }
    });
  }, [identity, messages]);

  const fetchMessages = useCallback(async () => {
    if (!identity || !conversationId) return;

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = '/conversations';
          return;
        }
        if (res.status === 404) {
          setError('Conversation not found');
          return;
        }
        throw new Error('Failed to load messages');
      }
      const data = await res.json();
      const msgs = data.messages || [];
      setMessages(msgs);

      const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
      if (lastId && lastId !== lastMessageIdRef.current) {
        lastMessageIdRef.current = lastId;
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
      }
    } catch (err) {
      if (!messages.length) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      }
    } finally {
      setLoadingMessages(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, conversationId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (!identity || !conversationId) return;
    wsSubscribe(conversationId);
  }, [identity, conversationId, wsSubscribe]);

  useEffect(() => {
    if (!wsMessage || !wsMessage.type) return;

    if (wsMessage.type === 'new_message' && wsMessage.message) {
      const msg = wsMessage.message as Message;
      if (msg.conversationId !== conversationId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        const updated = [...prev, msg];
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        return updated;
      });
    } else if (wsMessage.type === 'message_edited' && wsMessage.message) {
      const msg = wsMessage.message as Message;
      if (msg.conversationId !== conversationId) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    } else if (wsMessage.type === 'message_deleted' && wsMessage.message) {
      const msg = wsMessage.message as Message;
      if (msg.conversationId !== conversationId) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    } else if (
      (wsMessage.type === 'reaction_added' || wsMessage.type === 'reaction_removed') &&
      wsMessage.messageId
    ) {
      if (wsMessage.reactions) {
        setMessageReactions((prev) => ({
          ...prev,
          [wsMessage.messageId]: wsMessage.reactions,
        }));
      }
    } else if (wsMessage.type === 'user_typing' && wsMessage.conversationId === conversationId) {
      setTypingUsers((prev) => {
        if (wsMessage.did === identity?.did) return prev;
        if (prev.some((u) => u.did === wsMessage.did)) return prev;
        return [...prev, { did: wsMessage.did, name: wsMessage.name || null }];
      });
    } else if (
      wsMessage.type === 'user_stop_typing' &&
      wsMessage.conversationId === conversationId
    ) {
      setTypingUsers((prev) => prev.filter((u) => u.did !== wsMessage.did));
    }
  }, [wsMessage, conversationId, identity]);

  useEffect(() => {
    if (!identity || !conversationId || wsConnected) return;
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [identity, conversationId, fetchMessages, wsConnected]);

  const handleUploadComplete = (data: {
    mediaType: 'image' | 'file';
    mediaPath: string;
    mediaMeta: unknown;
  }) => {
    setUploadedMedia(data);
  };

  const handleUploadError = (errorMsg: string) => {
    setError(errorMsg);
  };

  const handleVoiceComplete = async (blob: Blob, durationMs: number) => {
    setVoiceSending(true);
    try {
      const { assetId, transcript } = await sendVoiceMessage(blob);
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: 'voice',
          content: { type: 'voice', assetId, transcript, durationMs },
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send voice message');
      }
      await fetchMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send voice message');
    } finally {
      setVoiceSending(false);
      setVoiceActive(false);
    }
  };

  const handleLocationSelected = async (location: LocationData) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: 'location',
          content: { type: 'location', ...location },
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send location');
      }
      await fetchMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send location');
    }
  };

  const handleSend = async () => {
    if ((!message.trim() && !uploadedMedia) || sending) return;

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (conversationId) sendStopTyping(conversationId);

    setSending(true);
    try {
      if (editingMessage) {
        const res = await fetch(
          `/api/conversations/${conversationId}/messages/${editingMessage.id}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: { type: 'text', text: message.trim() } }),
          }
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to edit');
        }
        setEditingMessage(null);
        setMessage('');
        await fetchMessages();
      } else {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { type: 'text', text: message.trim() || '' },
            replyTo: replyToMessage?.id || undefined,
            ...(uploadedMedia && {
              mediaType: uploadedMedia.mediaType,
              mediaPath: uploadedMedia.mediaPath,
              mediaMeta: uploadedMedia.mediaMeta,
            }),
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to send');
        }
        setReplyToMessage(null);
        setMessage('');
        setUploadedMedia(null);
        await fetchMessages();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            const formData = new FormData();
            formData.append('file', file);
            try {
              const res = await fetch(`/api/conversations/${conversationId}/upload`, {
                method: 'POST',
                body: formData,
              });
              if (res.ok) {
                const data = await res.json();
                handleUploadComplete(data);
              }
            } catch {
              handleUploadError('Failed to upload pasted image');
            }
          }
        }
      }
    },
    [conversationId]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const file = files[0];
      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch(`/api/conversations/${conversationId}/upload`, {
          method: 'POST',
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          handleUploadComplete(data);
        } else {
          const data = await res.json();
          handleUploadError(data.error || 'Upload failed');
        }
      } catch {
        handleUploadError('Failed to upload file');
      }
    },
    [conversationId]
  );

  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      setReplyToMessage(null);
      setEditingMessage(null);
      setMessage('');
    }
  };

  const handleMessageChange = (text: string) => {
    setMessage(text);
    if (!text.trim() || !conversationId) return;

    const now = Date.now();
    if (now - lastTypingSentRef.current > 2000) {
      sendTyping(conversationId, identity?.name || null);
      lastTypingSentRef.current = now;
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (conversationId) sendStopTyping(conversationId);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, []);

  const handleReply = (msg: Message) => {
    setReplyToMessage(msg);
    setEditingMessage(null);
  };

  const handleEdit = (msg: Message) => {
    setEditingMessage(msg);
    setReplyToMessage(null);
    const text =
      typeof msg.content === 'object' && msg.content?.text
        ? msg.content.text
        : typeof msg.content === 'string'
        ? msg.content
        : '';
    setMessage(text);
  };

  const handleDelete = async (msg: Message) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages/${msg.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }
      await fetchMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleReactionToggle = async (msgId: string, emoji: string, reacted: boolean) => {
    try {
      const method = reacted ? 'DELETE' : 'POST';
      const res = await fetch(`/api/messages/${msgId}/reactions`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to react');
      }
      const data = await res.json();
      setMessageReactions((prev) => ({ ...prev, [msgId]: data.reactions || [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to react');
    }
  };

  const scrollToMessage = (messageId: string) => {
    const element = document.getElementById(`msg-${messageId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.classList.add('bg-yellow-100', 'dark:bg-yellow-900/30');
      setTimeout(() => {
        element.classList.remove('bg-yellow-100', 'dark:bg-yellow-900/30');
      }, 1500);
    }
  };

  if (authLoading) {
    return <div className="max-w-2xl mx-auto mt-20 text-center text-gray-500">Loading...</div>;
  }

  if (!identity) return <LoginPrompt />;

  return (
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-200px)]">
      {/* Header */}
      <div className="flex items-center gap-4 pb-4 border-b border-gray-200 dark:border-gray-700">
        <Link
          href="/conversations"
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
        >
          ← Back
        </Link>
        <div className="flex-1">
          <h1 className="font-semibold">
            {conversation?.name ||
              (conversation?.type === 'direct' ? 'Direct Message' : 'Conversation')}
          </h1>
          {conversation?.type === 'group' && conversation?.participantCount && (
            <p className="text-xs text-gray-500 mt-1">
              {conversation.participantCount}{' '}
              {conversation.participantCount === 1 ? 'member' : 'members'}
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="my-2 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={chatAreaRef}
        className="flex-1 min-h-0 overflow-y-auto py-4 space-y-4"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {loadingMessages ? (
          <div className="text-center text-gray-500 mt-8">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            <p>No messages yet. Say hello! 👋</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isOwn = msg.fromDid === identity.did;
            const prevMsg = messages[index - 1];
            const showDateDivider =
              !prevMsg ||
              new Date(msg.createdAt).toDateString() !==
                new Date(prevMsg.createdAt).toDateString();
            const showSenderLabel =
              !isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider);
            const replyTo = msg.replyTo ? messages.find((m) => m.id === msg.replyTo) : null;

            return (
              <div key={msg.id} id={`msg-${msg.id}`}>
                {showDateDivider && (
                  <div className="flex items-center justify-center my-4">
                    <span className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-500">
                      {formatDateDivider(msg.createdAt)}
                    </span>
                  </div>
                )}

                {msg.contentType === 'system' ? (
                  <div className="text-center text-xs text-gray-500 my-2">
                    {typeof msg.content === 'object' && msg.content?.text
                      ? msg.content.text
                      : typeof msg.content === 'string'
                      ? msg.content
                      : JSON.stringify(msg.content)}
                  </div>
                ) : (
                  <MessageBubble
                    message={msg}
                    isOwn={isOwn}
                    senderLabel={handleMap[msg.fromDid] || msg.fromDid.slice(0, 16) + '...'}
                    showSenderLabel={showSenderLabel}
                    onReply={() => handleReply(msg)}
                    onEdit={() => handleEdit(msg)}
                    onDelete={() => handleDelete(msg)}
                    reactions={messageReactions[msg.id] || []}
                    onReactionToggle={(emoji, reacted) =>
                      handleReactionToggle(msg.id, emoji, reacted)
                    }
                    replyToMessage={replyTo}
                    onScrollToMessage={scrollToMessage}
                    mediaUrl={MEDIA_URL}
                  />
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 pt-2 border-t border-gray-200 dark:border-gray-700">
        <TypingIndicator typingUsers={typingUsers} />

        {replyToMessage && (
          <div className="mb-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Replying to{' '}
                {handleMap[replyToMessage.fromDid] ||
                  replyToMessage.fromDid.slice(0, 16) + '...'}
              </p>
              <p className="text-sm truncate text-gray-800 dark:text-gray-200">
                {typeof replyToMessage.content === 'object' && replyToMessage.content?.text
                  ? replyToMessage.content.text
                  : typeof replyToMessage.content === 'string'
                  ? replyToMessage.content
                  : ''}
              </p>
            </div>
            <button
              onClick={() => setReplyToMessage(null)}
              className="ml-2 p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            >
              ✕
            </button>
          </div>
        )}

        {editingMessage && (
          <div className="mb-2 p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-between">
            <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
              Editing message
            </p>
            <button
              onClick={() => {
                setEditingMessage(null);
                setMessage('');
              }}
              className="ml-2 p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded"
            >
              ✕
            </button>
          </div>
        )}

        {uploadedMedia && (
          <div className="mb-2 flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {uploadedMedia.mediaType === 'image' ? '🖼️' : '📎'}{' '}
              {(uploadedMedia.mediaMeta as { originalName?: string })?.originalName ?? 'file'}
            </span>
            <button
              onClick={() => setUploadedMedia(null)}
              className="ml-auto text-gray-500 hover:text-red-500"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 overflow-hidden">
          {voiceActive ? (
            <>
              <VoiceRecorder
                onRecordingStart={() => setVoiceActive(true)}
                onRecordingComplete={handleVoiceComplete}
                onCancel={() => setVoiceActive(false)}
                disabled={voiceSending}
              />
              {voiceSending && (
                <span className="text-xs text-gray-400 self-center flex-shrink-0">
                  Sending...
                </span>
              )}
            </>
          ) : (
            <>
              <div className="flex-1 flex items-end min-w-0 bg-gray-100 dark:bg-gray-800 rounded-2xl px-2 py-2">
                {/* Attach (left, inside) */}
                {capabilities.has('send:media') ? (
                  <FileUpload
                    conversationId={conversationId}
                    onUploadComplete={handleUploadComplete}
                    onUploadError={handleUploadError}
                  />
                ) : (
                  <div
                    className="p-1.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
                    title="Verify your identity to send files"
                  >
                    🔒
                  </div>
                )}
                {/* Text input */}
                <textarea
                  value={message}
                  onChange={(e) => {
                    handleMessageChange(e.target.value);
                    const el = e.target;
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  className="flex-1 min-w-0 bg-transparent resize-none outline-none text-sm px-2 py-0.5"
                  rows={1}
                  style={{ minHeight: '24px', maxHeight: '160px' }}
                />
                {/* Location (right, inside) */}
                <div className="relative flex-shrink-0">
                  {capabilities.has('send:location') ? (
                    <LocationPicker
                      onLocationSelected={handleLocationSelected}
                      disabled={sending}
                    />
                  ) : (
                    <div
                      className="p-1.5 opacity-50 cursor-not-allowed text-gray-400"
                      title="Verify your identity to share location"
                    >
                      🔒
                    </div>
                  )}
                </div>
                {/* Voice (right, inside) */}
                {capabilities.has('send:voice') ? (
                  <VoiceRecorder
                    onRecordingStart={() => setVoiceActive(true)}
                    onRecordingComplete={handleVoiceComplete}
                    onCancel={() => setVoiceActive(false)}
                    disabled={sending}
                  />
                ) : (
                  <div
                    className="p-1.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
                    title="Verify your identity to send voice messages"
                  >
                    🔒
                  </div>
                )}
              </div>
              {/* Send (outside) */}
              <button
                onClick={handleSend}
                disabled={(!message.trim() && !uploadedMedia) || sending}
                className={`p-3 rounded-full transition ${
                  (message.trim() || uploadedMedia) && !sending
                    ? 'bg-orange-500 text-white hover:bg-orange-600'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-400'
                }`}
              >
                {sending ? '...' : editingMessage ? '✓' : '➤'}
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// ─── Router: DID vs legacy ────────────────────────────────────────────────────

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const decoded = decodeURIComponent(params.id);

  if (decoded.startsWith('did:')) {
    return <DIDConversationView did={decoded} />;
  }

  return <LegacyConversationView conversationId={params.id} />;
}
