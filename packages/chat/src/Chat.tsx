'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatAccess } from './hooks/useChatAccess';
import { useChatMessages } from './hooks/useChatMessages';
import type { ChatMessage } from './hooks/useChatMessages';
import { useChatActions } from './hooks/useChatActions';
import { useChatWebSocket } from './hooks/useChatWebSocket';
import { useFileUpload } from './hooks/useFileUpload';
import { useVoiceRecording } from './hooks/useVoiceRecording';
import { useLocationShare } from './hooks/useLocationShare';
import { MessageBubble } from './MessageBubble';
import { VoiceRecorder } from './VoiceRecorder';

interface ChatProps {
  did: string;
  currentUserDid?: string;
  mediaUrl?: string;
  enableVoice?: boolean;
  enableMedia?: boolean;
  enableLocation?: boolean;
  onAccessDenied?: () => void;
  className?: string;
}

function computeReactions(
  reactions: { emoji: string; senderDid: string }[] | undefined,
  currentUserDid?: string,
) {
  if (!reactions?.length) return [];
  const map = new Map<string, { count: number; reacted: boolean }>();
  for (const r of reactions) {
    const e = map.get(r.emoji) ?? { count: 0, reacted: false };
    map.set(r.emoji, { count: e.count + 1, reacted: e.reacted || r.senderDid === currentUserDid });
  }
  return Array.from(map.entries()).map(([emoji, data]) => ({ emoji, ...data }));
}

function toMsgShape(msg: ChatMessage) {
  return {
    id: msg.id,
    conversationId: msg.did,
    fromDid: msg.senderDid,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: msg.content as any,
    contentType: msg.content.type ?? 'text',
    replyTo: msg.replyTo ?? null,
    linkPreviews: null,
    createdAt: msg.createdAt,
    editedAt: msg.editedAt ?? null,
    deletedAt: null,
  };
}

export function Chat({
  did,
  currentUserDid,
  mediaUrl,
  enableVoice = false,
  enableMedia = false,
  enableLocation = false,
  onAccessDenied,
  className,
}: ChatProps) {
  const access = useChatAccess(did);
  const { messages, hasMore, loadMore, isLoading, pushMessage } = useChatMessages(did);
  const { sendMessage, addReaction, removeReaction, editMessage, deleteMessage, isSending } =
    useChatActions(did);
  const { typingUsers, sendTyping, stopTyping, lastMessage } = useChatWebSocket(did);
  const { uploadFile } = useFileUpload();
  const { sendVoice } = useVoiceRecording();
  const { shareLocation } = useLocationShare();

  const [composerText, setComposerText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; text: string } | null>(null);
  const [editingMsg, setEditingMsg] = useState<{ id: string; text: string } | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fire onAccessDenied when access resolves to denied
  useEffect(() => {
    if (!access.isLoading && !access.allowed && onAccessDenied) {
      onAccessDenied();
    }
  }, [access.isLoading, access.allowed, onAccessDenied]);

  // Push new WebSocket messages into the list
  useEffect(() => {
    if (lastMessage?.type === 'new_message' && lastMessage.message) {
      pushMessage(lastMessage.message as ChatMessage);
    }
  }, [lastMessage, pushMessage]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages.length]);

  // Infinite scroll up via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !isLoading) loadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadMore]);

  const messageById = new Map(messages.map(m => [m.id, m]));

  const handleSend = useCallback(async () => {
    const text = composerText.trim();
    if (!text || isSending) return;
    if (editingMsg) {
      await editMessage(editingMsg.id, { type: 'text', text });
      setEditingMsg(null);
    } else {
      await sendMessage({ type: 'text', text }, replyTo ? { replyTo: replyTo.id } : undefined);
      setReplyTo(null);
    }
    setComposerText('');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    stopTyping();
  }, [composerText, isSending, editingMsg, replyTo, editMessage, sendMessage, stopTyping]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setComposerText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    sendTyping();
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(stopTyping, 3000);
  };

  const handleReply = (msg: ChatMessage) => {
    const text = typeof msg.content === 'object' && 'text' in msg.content
      ? String(msg.content.text ?? '') : '';
    setReplyTo({ id: msg.id, text });
    setEditingMsg(null);
    textareaRef.current?.focus();
  };

  const handleEdit = (msg: ChatMessage) => {
    const text = typeof msg.content === 'object' && 'text' in msg.content
      ? String(msg.content.text ?? '') : '';
    setEditingMsg({ id: msg.id, text });
    setComposerText(text);
    setReplyTo(null);
    textareaRef.current?.focus();
  };

  const handleScrollToMessage = (messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const clearComposerState = () => {
    setReplyTo(null);
    setEditingMsg(null);
    setComposerText('');
  };

  const handleVoiceComplete = useCallback(async (blob: Blob, durationMs: number) => {
    setVoiceSending(true);
    try {
      const { assetId, transcript } = await sendVoice(blob);
      await sendMessage({ type: 'voice', assetId, transcript, durationMs });
    } catch {
      // error tracked in hook
    } finally {
      setVoiceSending(false);
      setVoiceActive(false);
    }
  }, [sendVoice, sendMessage]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
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
    } catch {
      // error tracked in hook
    }
  };

  const handleShareLocation = async () => {
    try {
      const { lat, lng, accuracy } = await shareLocation();
      await sendMessage({ type: 'location', lat, lng, accuracy });
    } catch {
      // error tracked in hook
    }
  };

  const typingNames = Array.from(typingUsers.values())
    .map(u => u.name ?? u.did.slice(0, 8))
    .join(', ');

  if (access.isLoading) {
    return (
      <div className={`flex items-center justify-center h-full text-slate-400 ${className ?? ''}`}>
        <span className="animate-pulse text-sm">Checking access…</span>
      </div>
    );
  }

  if (!access.allowed) {
    return (
      <div className={`flex flex-col items-center justify-center h-full gap-3 text-slate-400 ${className ?? ''}`}>
        <svg className="w-10 h-10 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <p className="text-sm">You don't have access to this conversation.</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full bg-white dark:bg-zinc-900 ${className ?? ''}`}>
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
        <div ref={sentinelRef} />
        {isLoading && (
          <p className="text-center text-xs text-slate-400 py-2 animate-pulse">Loading…</p>
        )}

        {messages.map((msg, idx) => {
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const showSenderLabel = !prevMsg || prevMsg.senderDid !== msg.senderDid;
          const replyToMsg = msg.replyTo ? messageById.get(msg.replyTo) : undefined;
          return (
            <div key={msg.id} id={`msg-${msg.id}`}>
              <MessageBubble
                message={toMsgShape(msg)}
                isOwn={msg.senderDid === currentUserDid}
                senderLabel={msg.senderDid.slice(-8)}
                showSenderLabel={showSenderLabel}
                onReply={() => handleReply(msg)}
                onEdit={() => handleEdit(msg)}
                onDelete={() => deleteMessage(msg.id)}
                reactions={computeReactions(msg.reactions, currentUserDid)}
                onReactionToggle={(emoji, reacted) =>
                  reacted ? removeReaction(msg.id, emoji) : addReaction(msg.id, emoji)
                }
                replyToMessage={replyToMsg ? toMsgShape(replyToMsg) : undefined}
                onScrollToMessage={handleScrollToMessage}
                mediaUrl={mediaUrl}
              />
            </div>
          );
        })}

        {typingNames && (
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="flex gap-0.5">
              {[0, 1, 2].map(i => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
            <span className="text-xs text-slate-400">{typingNames} typing…</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 dark:border-zinc-700 px-3 py-2 bg-white dark:bg-zinc-900">
        {(replyTo || editingMsg) && (
          <div className="flex items-start justify-between mb-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs">
            <div className="min-w-0">
              <p className="font-semibold text-orange-500">{editingMsg ? 'Editing' : '↩ Replying to'}</p>
              <p className="truncate text-slate-500 dark:text-slate-400">
                {(editingMsg?.text ?? replyTo?.text ?? '').slice(0, 80)}
              </p>
            </div>
            <button
              onClick={clearComposerState}
              className="ml-2 flex-shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Cancel"
            >
              ✕
            </button>
          </div>
        )}

        {voiceActive && enableVoice ? (
          <div className="flex items-center gap-2">
            <VoiceRecorder
              onRecordingStart={() => setVoiceActive(true)}
              onRecordingComplete={handleVoiceComplete}
              onCancel={() => setVoiceActive(false)}
              disabled={voiceSending}
            />
            {voiceSending && (
              <span className="text-xs text-slate-400 flex-shrink-0">Sending…</span>
            )}
          </div>
        ) : (
          <div className="flex items-end gap-2">
            {enableMedia && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSending}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition disabled:opacity-50 flex-shrink-0"
                  title="Attach file"
                >
                  {'\uD83D\uDCCE'}
                </button>
              </>
            )}
            <textarea
              ref={textareaRef}
              value={composerText}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder="Message…"
              rows={1}
              className="flex-1 resize-none overflow-hidden rounded-2xl bg-slate-100 dark:bg-zinc-800 px-4 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 outline-none focus:ring-2 focus:ring-orange-500/50"
              style={{ minHeight: '38px', maxHeight: '120px' }}
            />
            {enableLocation && (
              <button
                onClick={handleShareLocation}
                disabled={isSending}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition disabled:opacity-50 flex-shrink-0"
                title="Share location"
              >
                {'\uD83D\uDCCD'}
              </button>
            )}
            {enableVoice && (
              <VoiceRecorder
                onRecordingStart={() => setVoiceActive(true)}
                onRecordingComplete={handleVoiceComplete}
                onCancel={() => setVoiceActive(false)}
                disabled={isSending}
              />
            )}
            <button
              onClick={handleSend}
              disabled={isSending || !composerText.trim()}
              className="flex-shrink-0 w-9 h-9 rounded-full bg-orange-500 text-white flex items-center justify-center hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Send"
            >
              <svg className="w-4 h-4 translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
