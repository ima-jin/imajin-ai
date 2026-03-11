'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { MessageBubble, ChatComposer } from '@imajin/chat';
import type { ComposerPayload, MessageContent } from '@imajin/chat';

interface Message {
  id: string;
  conversationId: string;
  fromDid: string;
  content: MessageContent;
  contentType: string;
  replyTo: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface Profile {
  did: string;
  handle?: string;
  name?: string;
}

type NameDisplayPolicy = 'real_name' | 'handle' | 'anonymous' | 'attendee_choice';
type AttendeeDisplayPref = 'real_name' | 'handle' | 'anonymous';

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

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

interface EventChatProps {
  eventId: string;
  compact?: boolean;
}

export function EventChat({ eventId, compact = false }: EventChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTicket, setHasTicket] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, Array<{ emoji: string; count: number; reacted: boolean }>>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Name display policy
  const [nameDisplayPolicy, setNameDisplayPolicy] = useState<NameDisplayPolicy>('attendee_choice');
  const [myDisplayPref, setMyDisplayPref] = useState<AttendeeDisplayPref>('handle');

  const [capabilities, setCapabilities] = useState<Set<string>>(new Set(['send:text']));

  const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
  const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';
  const INPUT_URL = process.env.NEXT_PUBLIC_INPUT_URL || 'http://localhost:3008';

  // Get current user's DID and resolve capabilities from session tier
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCurrentUserDid(data.did);
          const tier = data.tier || 'soft';
          if (tier === 'hard') {
            setCapabilities(new Set(['send:text', 'send:voice', 'send:media', 'send:location']));
          } else {
            setCapabilities(new Set(['send:text']));
          }
        }
      } catch (err) {
        console.error('Failed to fetch session:', err);
      }
    }
    fetchSession();
  }, [AUTH_SERVICE_URL]);

  // Load attendee display pref from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(`eventChat_displayPref_${eventId}`);
    if (stored && ['real_name', 'handle', 'anonymous'].includes(stored)) {
      setMyDisplayPref(stored as AttendeeDisplayPref);
    }
  }, [eventId]);

  // Fetch event name display policy
  useEffect(() => {
    async function fetchPolicy() {
      try {
        const res = await fetch(`/api/events/${eventId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.event?.nameDisplayPolicy) {
            setNameDisplayPolicy(data.event.nameDisplayPolicy as NameDisplayPolicy);
          }
        }
      } catch {
        // fallback to default
      }
    }
    fetchPolicy();
  }, [eventId]);

  // Check ticket ownership
  useEffect(() => {
    async function checkTicket() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          setHasTicket(data.hasAccess ?? data.hasTicket);
          if (!data.hasAccess && !data.hasTicket) {
            setLoading(false);
          }
        } else {
          setHasTicket(false);
          setLoading(false);
        }
      } catch {
        setHasTicket(false);
        setLoading(false);
      }
    }
    checkTicket();
  }, [eventId]);

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    if (hasTicket === false) return;

    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
        credentials: 'include',
      });

      if (!res.ok) {
        if (res.status === 403) {
          setHasTicket(false);
          setLoading(false);
          return;
        }
        throw new Error('Failed to load messages');
      }

      const data = await res.json();
      const newMessages: Message[] = (data.messages || []).map((m: any) => ({
        ...m,
        replyTo: m.replyTo ?? null,
        editedAt: m.editedAt ?? null,
        deletedAt: m.deletedAt ?? null,
      }));
      const hadMessages = messages.length;
      setMessages(newMessages);
      setLoading(false);

      // Only auto-scroll when new messages arrive, not on every poll
      if (newMessages.length > hadMessages) {
        setTimeout(() => {
          if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          }
        }, 100);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, hasTicket, CHAT_SERVICE_URL]);

  // Initial fetch and polling
  useEffect(() => {
    if (hasTicket === null) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [fetchMessages, hasTicket]);

  // Resolve profiles for message senders
  useEffect(() => {
    if (!messages.length) return;
    const unknownDids = Array.from(new Set(messages.map(m => m.fromDid))).filter(
      d => !profiles[d]
    );
    if (!unknownDids.length) return;

    unknownDids.forEach(async (did) => {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`);
        if (res.ok) {
          const data = await res.json();
          setProfiles(prev => ({
            ...prev,
            [did]: { did, handle: data.handle, name: data.name },
          }));
        } else {
          setProfiles(prev => ({ ...prev, [did]: { did } }));
        }
      } catch {
        setProfiles(prev => ({ ...prev, [did]: { did } }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, AUTH_SERVICE_URL]);

  // Fetch reactions for messages
  useEffect(() => {
    if (!currentUserDid || !messages.length) return;

    messages.forEach(async (msg) => {
      if (msg.deletedAt) return;
      try {
        const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages/${msg.id}/reactions`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setMessageReactions(prev => ({ ...prev, [msg.id]: data.reactions || [] }));
        }
      } catch {
        // Ignore reaction fetch errors
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserDid, messages.length, CHAT_SERVICE_URL, eventId]);

  // Handle composer sends
  const handleComposerSend = async (payload: ComposerPayload) => {
    setSending(true);
    setError(null);
    try {
      if (payload.kind === 'edit') {
        const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages/${payload.messageId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            content: { type: 'text', text: payload.text },
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to edit');
        }
        setEditingMessage(null);
        await fetchMessages();
      } else if (payload.kind === 'text') {
        const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            content: { type: 'text', text: payload.text },
            replyTo: payload.replyTo,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to send');
        }
        setReplyToMessage(null);
        await fetchMessages();
      } else if (payload.kind === 'voice') {
        const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            contentType: 'voice',
            content: { type: 'voice', assetId: payload.assetId, transcript: payload.transcript, durationMs: payload.durationMs },
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to send voice message');
        }
        await fetchMessages();
      } else if (payload.kind === 'media') {
        const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            content: { type: 'media', assetId: payload.assetId, filename: payload.filename, mimeType: payload.mimeType, size: payload.size, width: payload.width, height: payload.height },
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to send file');
        }
        await fetchMessages();
      } else if (payload.kind === 'location') {
        const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            contentType: 'location',
            content: { type: 'location', lat: payload.lat, lng: payload.lng, accuracy: payload.accuracy },
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to send location');
        }
        await fetchMessages();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handleReply = (msg: Message) => {
    setReplyToMessage(msg);
    setEditingMessage(null);
  };

  const handleEdit = (msg: Message) => {
    setEditingMessage(msg);
    setReplyToMessage(null);
  };

  const handleDelete = async (msg: Message) => {
    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages/${msg.id}`, {
        method: 'DELETE',
        credentials: 'include',
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
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages/${msgId}/reactions`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to react');
      }
      const data = await res.json();
      setMessageReactions(prev => ({
        ...prev,
        [msgId]: data.reactions || [],
      }));
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

  const getDisplayName = (did: string, msgIndex?: number): string => {
    const profile = profiles[did];
    const isOwnMessage = did === currentUserDid;
    let effectivePolicy: AttendeeDisplayPref;

    if (nameDisplayPolicy === 'attendee_choice') {
      effectivePolicy = isOwnMessage ? myDisplayPref : 'handle';
    } else {
      effectivePolicy = nameDisplayPolicy as AttendeeDisplayPref;
    }

    if (effectivePolicy === 'anonymous') {
      return msgIndex !== undefined ? `Attendee #${msgIndex + 1}` : 'Attendee';
    }

    if (!profile) return did.slice(0, 16) + '...';

    if (effectivePolicy === 'handle') {
      if (profile.handle) return `@${profile.handle}`;
      return did.slice(0, 16) + '...';
    }

    // real_name
    if (profile.name) return profile.name;
    if (profile.handle) return `@${profile.handle}`;
    return did.slice(0, 16) + '...';
  };

  const handleSetDisplayPref = (pref: AttendeeDisplayPref) => {
    setMyDisplayPref(pref);
    localStorage.setItem(`eventChat_displayPref_${eventId}`, pref);
  };

  if (loading) {
    return (
      <div className={`${compact ? 'h-[400px]' : 'flex-1'} flex items-center justify-center`}>
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (hasTicket === false) {
    if (compact) return null;
    return (
      <div className="max-w-4xl mx-auto mt-20">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 text-center">
          <div className="text-6xl mb-4">🎫</div>
          <h2 className="text-2xl font-bold mb-2">Get a Ticket to Join the Conversation</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            You need a ticket to access the event lobby chat. Purchase a ticket to connect with
            other attendees.
          </p>
          <Link
            href={`/${eventId}#tickets`}
            className="inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
          >
            View Tickets
          </Link>
        </div>
      </div>
    );
  }

  // For anonymous policy, compute stable attendee numbers
  const uniqueSenders = nameDisplayPolicy === 'anonymous'
    ? Array.from(new Set(messages.map(m => m.fromDid)))
    : [];

  const replyToText =
    replyToMessage && typeof replyToMessage.content === 'object' && (replyToMessage.content as any)?.text
      ? (replyToMessage.content as any).text
      : replyToMessage && typeof replyToMessage.content === 'string'
      ? replyToMessage.content
      : '';

  const editingInitialText =
    editingMessage && typeof editingMessage.content === 'object' && (editingMessage.content as any)?.text
      ? (editingMessage.content as any).text
      : editingMessage && typeof editingMessage.content === 'string'
      ? editingMessage.content
      : '';

  const messagesAreaClass = compact
    ? 'h-[400px] overflow-y-auto space-y-4 mb-4 scrollbar-dark'
    : 'flex-1 overflow-y-auto space-y-4 mb-4 scrollbar-dark';

  return (
    <div className={compact ? '' : 'flex flex-col flex-1'}>
      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* Messages */}
      <div className={messagesAreaClass}>
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            <p className="text-4xl mb-2">💬</p>
            <p>No messages yet. Start the conversation!</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isOwn = msg.fromDid === currentUserDid;
            const prevMsg = messages[index - 1];
            const showDateDivider =
              !prevMsg ||
              new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();

            const showSenderLabel = !isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider);

            const senderIndex = uniqueSenders.indexOf(msg.fromDid);
            const senderLabel = getDisplayName(msg.fromDid, senderIndex >= 0 ? senderIndex : undefined);

            const replyTo = msg.replyTo ? messages.find(m => m.id === msg.replyTo) : null;

            return (
              <div key={msg.id} id={`msg-${msg.id}`}>
                {showDateDivider && (
                  <div className="flex items-center justify-center my-4">
                    <span className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-500">
                      {formatDateDivider(msg.createdAt)}
                    </span>
                  </div>
                )}

                <MessageBubble
                  message={msg}
                  isOwn={isOwn}
                  senderLabel={senderLabel}
                  showSenderLabel={showSenderLabel}
                  onReply={() => handleReply(msg)}
                  onEdit={() => handleEdit(msg)}
                  onDelete={() => handleDelete(msg)}
                  reactions={messageReactions[msg.id] || []}
                  onReactionToggle={(emoji, reacted) => handleReactionToggle(msg.id, emoji, reacted)}
                  replyToMessage={replyTo ?? undefined}
                  onScrollToMessage={scrollToMessage}
                  mediaUrl={MEDIA_URL}
                />
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="bg-white dark:bg-gray-900 pt-4 border-t border-gray-200 dark:border-gray-700">
        <ChatComposer
          onSend={handleComposerSend}
          inputUrl={INPUT_URL}
          capabilities={capabilities}
          disabled={sending}
          replyTo={replyToMessage ? {
            id: replyToMessage.id,
            senderLabel: getDisplayName(replyToMessage.fromDid),
            text: replyToText,
          } : null}
          onCancelReply={() => setReplyToMessage(null)}
          editing={editingMessage ? {
            messageId: editingMessage.id,
            initialText: editingInitialText,
          } : null}
          onCancelEdit={() => setEditingMessage(null)}
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-gray-400">Visible to all ticket holders</p>
          {nameDisplayPolicy === 'attendee_choice' && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">Show me as:</span>
              <select
                value={myDisplayPref}
                onChange={(e) => handleSetDisplayPref(e.target.value as AttendeeDisplayPref)}
                className="text-xs bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-orange-500"
              >
                <option value="real_name">Real name</option>
                <option value="handle">@handle</option>
                <option value="anonymous">Anonymous</option>
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
