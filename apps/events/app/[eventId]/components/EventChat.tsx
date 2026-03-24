'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  MessageBubble,
  VoiceMessage,
  MediaMessage,
  LocationMessage,
  VoiceRecorder,
  useChatWebSocket,
  useFileUpload,
  useVoiceRecording,
  useLocationShare,
} from '@imajin/chat';
import type { MessageContent, VoiceContent, MediaContent, LocationContent, TextContent } from '@imajin/chat';

interface RawReaction {
  emoji: string;
  senderDid?: string;
  fromDid?: string;
}

interface Message {
  id: string;
  conversationId: string;
  conversationDid?: string;
  fromDid: string;
  content: MessageContent;
  contentType: string;
  replyTo: string | null;
  linkPreviews?: null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  mediaType?: null;
  mediaPath?: null;
  mediaMeta?: null;
  reactions?: RawReaction[];
}

function computeReactions(
  raw: RawReaction[] | undefined,
  myDid: string | null,
): { emoji: string; count: number; reacted: boolean }[] {
  if (!raw?.length) return [];
  const map = new Map<string, { count: number; reacted: boolean }>();
  for (const r of raw) {
    const sender = r.senderDid ?? r.fromDid ?? '';
    const e = map.get(r.emoji) ?? { count: 0, reacted: false };
    map.set(r.emoji, { count: e.count + 1, reacted: e.reacted || sender === myDid });
  }
  return Array.from(map.entries()).map(([emoji, data]) => ({ emoji, ...data }));
}

interface Profile {
  did: string;
  handle?: string;
  name?: string;
}

type NameDisplayPolicy = 'real_name' | 'handle' | 'anonymous' | 'attendee_choice';
type AttendeeDisplayPref = 'real_name' | 'handle' | 'anonymous';

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
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

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

function MessageContentRenderer({ msg, isOwn }: { msg: Message; isOwn: boolean }) {
  const content = msg.content;
  const ct = content.type || msg.contentType || 'text';

  if (ct === 'voice') {
    const v = content as VoiceContent;
    return <VoiceMessage assetId={v.assetId} transcript={v.transcript} durationMs={v.durationMs} waveform={v.waveform} isOwn={isOwn} mediaUrl={MEDIA_URL} />;
  }
  if (ct === 'media') {
    const m = content as MediaContent;
    return <MediaMessage assetId={m.assetId} filename={m.filename} mimeType={m.mimeType} size={m.size} width={m.width} height={m.height} caption={m.caption} isOwn={isOwn} mediaUrl={MEDIA_URL} />;
  }
  if (ct === 'location') {
    const l = content as LocationContent;
    return <LocationMessage lat={l.lat} lng={l.lng} label={l.label} accuracy={l.accuracy} isOwn={isOwn} />;
  }
  const t = content as TextContent;
  return <p className="text-sm whitespace-pre-wrap">{t.text}</p>;
}

interface EventChatProps {
  did: string;          // Event DID (conversation identifier)
  eventId: string;      // Still needed for event-specific API calls
  compact?: boolean;
}

export function EventChat({ did, eventId, compact = false }: EventChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<{ id: string; text: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Name display policy
  const [nameDisplayPolicy, setNameDisplayPolicy] = useState<NameDisplayPolicy>('attendee_choice');
  const [myDisplayPref, setMyDisplayPref] = useState<AttendeeDisplayPref>('handle');

  // Voice state
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set(['send:text']));

  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
  const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';

  const { lastMessage, typingUsers, sendTyping, stopTyping } = useChatWebSocket(did);
  const { uploadFile } = useFileUpload();
  const { sendVoice } = useVoiceRecording();
  const { shareLocation } = useLocationShare();

  // Get current user's DID and resolve capabilities from session tier
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCurrentUserDid(data.did);
          // All authenticated users get full chat capabilities
          setCapabilities(new Set(['send:text', 'send:voice', 'send:media', 'send:location']));
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

  // Mark conversation as read
  const markRead = useCallback(async () => {
    try {
      await fetch(
        `${CHAT_SERVICE_URL}/api/d/${encodeURIComponent(did)}/read`,
        { method: 'POST', credentials: 'include' }
      );
    } catch {
      // non-fatal
    }
  }, [did, CHAT_SERVICE_URL]);

  // Initial message fetch (DID-based route)
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(
        `${CHAT_SERVICE_URL}/api/d/${encodeURIComponent(did)}/messages`,
        { credentials: 'include' }
      );

      if (!res.ok) {
        throw new Error('Failed to load messages');
      }

      const data = await res.json();
      setMessages(data.messages || []);
      setLoading(false);
      markRead();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      setLoading(false);
    }
  }, [did, CHAT_SERVICE_URL, markRead]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'new_message') {
      const msg = lastMessage.message as Message | undefined;
      if (msg) {
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        markRead();
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }, 100);
      }
    }
  }, [lastMessage]);

  // Resolve profiles for message senders
  useEffect(() => {
    if (!messages.length) return;
    const unknownDids = Array.from(new Set(messages.map(m => m.fromDid))).filter(
      d => !profiles[d]
    );
    if (!unknownDids.length) return;

    unknownDids.forEach(async (senderDid) => {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(senderDid)}`);
        if (res.ok) {
          const data = await res.json();
          setProfiles(prev => ({
            ...prev,
            [senderDid]: { did: senderDid, handle: data.handle, name: data.name },
          }));
        } else {
          setProfiles(prev => ({ ...prev, [senderDid]: { did: senderDid } }));
        }
      } catch {
        setProfiles(prev => ({ ...prev, [senderDid]: { did: senderDid } }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, AUTH_SERVICE_URL]);

  // Send a message with arbitrary content (DID-based route)
  const sendMessage = async (content: MessageContent, replyToId?: string) => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `${CHAT_SERVICE_URL}/api/d/${encodeURIComponent(did)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ content, ...(replyToId ? { replyToMessageId: replyToId } : {}) }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send message');
      }
      // WebSocket will push the new message — no need to refetch
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleScrollToMessage = (messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleReply = (msg: Message) => {
    setReplyToMessage(msg);
    setEditingMessage(null);
  };

  const handleEdit = (msg: Message) => {
    const text = (msg.content as any)?.text || '';
    setEditingMessage({ id: msg.id, text });
    setMessage(text);
    setReplyToMessage(null);
  };

  const handleDelete = async (msgId: string) => {
    try {
      await fetch(
        `${CHAT_SERVICE_URL}/api/d/${encodeURIComponent(did)}/messages/${msgId}`,
        { method: 'DELETE', credentials: 'include' }
      );
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, deletedAt: new Date().toISOString() } : m));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleReactionToggle = async (msgId: string, emoji: string, reacted: boolean) => {
    try {
      const method = reacted ? 'DELETE' : 'POST';
      const res = await fetch(
        `${CHAT_SERVICE_URL}/api/d/${encodeURIComponent(did)}/messages/${msgId}/reactions`,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ emoji }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setMessages(prev =>
          prev.map(m => m.id === msgId ? { ...m, reactions: data.reactions || [] } : m)
        );
      }
    } catch {
      // ignore reaction errors
    }
  };

  // Send text message
  const handleSend = async () => {
    if (!message.trim() || sending) return;
    const text = message.trim();
    setMessage('');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    stopTyping();

    if (editingMessage) {
      setEditingMessage(null);
      setSending(true);
      try {
        const res = await fetch(
          `${CHAT_SERVICE_URL}/api/d/${encodeURIComponent(did)}/messages/${editingMessage.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ content: { type: 'text', text } }),
          }
        );
        if (!res.ok) throw new Error('Failed to edit message');
        const data = await res.json();
        setMessages(prev => prev.map(m => m.id === editingMessage.id ? { ...m, ...data.message } : m));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to edit');
      } finally {
        setSending(false);
      }
      return;
    }

    const replyToId = replyToMessage?.id;
    setReplyToMessage(null);
    await sendMessage({ type: 'text', text }, replyToId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    sendTyping();
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      stopTyping();
    }, 2000);
  };

  // Voice recording complete handler
  const handleVoiceComplete = useCallback(async (blob: Blob, durationMs: number) => {
    setVoiceSending(true);
    try {
      const { assetId, transcript } = await sendVoice(blob);
      await sendMessage({ type: 'voice', assetId, transcript, durationMs });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send voice message');
    } finally {
      setVoiceSending(false);
      setVoiceActive(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendVoice]);

  // File upload (media message)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setSending(true);
    setError(null);
    try {
      const { assetId, width, height } = await uploadFile(file);
      await sendMessage({
        type: 'media',
        assetId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        width,
        height,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file');
      setSending(false);
    }
  };

  // Location sharing
  const handleShareLocation = async () => {
    try {
      const { lat, lng, accuracy } = await shareLocation();
      await sendMessage({ type: 'location', lat, lng, accuracy });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to get your location');
    }
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  const getDisplayName = (senderDid: string, msgIndex?: number): string => {
    const profile = profiles[senderDid];

    const isOwnMessage = senderDid === currentUserDid;
    let effectivePolicy: AttendeeDisplayPref;

    if (nameDisplayPolicy === 'attendee_choice') {
      effectivePolicy = isOwnMessage ? myDisplayPref : 'handle';
    } else {
      effectivePolicy = nameDisplayPolicy as AttendeeDisplayPref;
    }

    if (effectivePolicy === 'anonymous') {
      return msgIndex !== undefined ? `Attendee #${msgIndex + 1}` : 'Attendee';
    }

    if (!profile) return senderDid.slice(0, 16) + '...';

    if (effectivePolicy === 'handle') {
      if (profile.handle) return `@${profile.handle}`;
      return senderDid.slice(0, 16) + '...';
    }

    // real_name
    if (profile.name) return profile.name;
    if (profile.handle) return `@${profile.handle}`;
    return senderDid.slice(0, 16) + '...';
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
            <p className="text-4xl mb-2">{'\uD83D\uDCAC'}</p>
            <p>No messages yet. Start the conversation!</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isOwn = msg.fromDid === currentUserDid;
            const prevMsg = messages[index - 1];
            const showDateDivider =
              !prevMsg ||
              new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();

            const uniqueSenders = nameDisplayPolicy === 'anonymous'
              ? Array.from(new Set(messages.map(m => m.fromDid)))
              : [];
            const senderIndex = uniqueSenders.indexOf(msg.fromDid);

            const showSenderLabel =
              !isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider);
            const replyToMsg = msg.replyTo
              ? messages.find(m => m.id === msg.replyTo) ?? null
              : null;

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
                  senderLabel={getDisplayName(msg.fromDid, senderIndex >= 0 ? senderIndex : undefined)}
                  showSenderLabel={showSenderLabel}
                  onReply={() => handleReply(msg)}
                  onEdit={() => handleEdit(msg)}
                  onDelete={() => handleDelete(msg.id)}
                  reactions={computeReactions(msg.reactions, currentUserDid)}
                  onReactionToggle={(emoji, reacted) => handleReactionToggle(msg.id, emoji, reacted)}
                  replyToMessage={replyToMsg}
                  onScrollToMessage={handleScrollToMessage}
                  mediaUrl={MEDIA_URL}
                />
              </div>
            );
          })
        )}

        {/* Typing indicators */}
        {typingUsers.size > 0 && (
          <div className="flex justify-start">
            <div className="px-4 py-2 rounded-2xl bg-gray-100 dark:bg-gray-800 rounded-bl-md">
              <p className="text-xs text-gray-400 italic">
                {Array.from(typingUsers.values())
                  .map(u => u.name || u.did.slice(0, 12) + '…')
                  .join(', ')}{' '}
                {typingUsers.size === 1 ? 'is' : 'are'} typing…
              </p>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="bg-white dark:bg-gray-900 pt-4 border-t border-gray-200 dark:border-gray-700 overflow-hidden">
        {(replyToMessage || editingMessage) && (
          <div className="mb-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-xs flex items-center justify-between">
            <span className="font-semibold text-orange-500">
              {editingMessage ? 'Editing message' : `↩ Replying to ${getDisplayName(replyToMessage!.fromDid)}`}
            </span>
            <button
              onClick={() => { setReplyToMessage(null); setEditingMessage(null); setMessage(''); }}
              className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              ✕
            </button>
          </div>
        )}
        {voiceActive ? (
          <div className="flex items-center gap-2 flex-1">
            {voiceSending && (
              <span className="text-sm text-gray-500 flex-shrink-0">Processing voice...</span>
            )}
          </div>
        ) : (
          /* Normal input */
          <div className="flex items-end gap-2">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
            />
            {/* Input container */}
            <div className="flex-1 flex items-end min-w-0 bg-gray-100 dark:bg-gray-800 rounded-2xl px-2 py-2">
              {/* Attach (left, inside) */}
              {capabilities.has('send:media') ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                  className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-50 flex-shrink-0 transition-colors"
                  title="Attach file"
                >
                  {'\uD83D\uDCCE'}
                </button>
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
                onChange={handleTextChange}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="flex-1 min-w-0 bg-transparent resize-none outline-none text-sm px-2 py-0.5"
                rows={1}
                style={{ minHeight: '24px', maxHeight: '160px' }}
              />

              {/* Location (right, inside) */}
              {capabilities.has('send:location') ? (
                <button
                  onClick={handleShareLocation}
                  disabled={sending}
                  className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-50 flex-shrink-0 transition-colors"
                  title="Share location"
                >
                  {'\uD83D\uDCCD'}
                </button>
              ) : (
                <div
                  className="p-1.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
                  title="Verify your identity to share location"
                >
                  🔒
                </div>
              )}

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
              disabled={!message.trim() || sending}
              className={`p-3 rounded-full transition flex-shrink-0 ${
                message.trim() && !sending
                  ? 'bg-orange-500 text-white hover:bg-orange-600'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400'
              }`}
            >
              {sending ? '...' : '\u27A4'}
            </button>
          </div>
        )}
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
