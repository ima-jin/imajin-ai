'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useChatAccess } from './hooks/useChatAccess';
import { useChatMessages } from './hooks/useChatMessages';
import { useDidNames } from './hooks/useDidNames';
import type { ChatMessage } from './hooks/useChatMessages';
import { useChatActions } from './hooks/useChatActions';
import { useChatWebSocket } from './hooks/useChatWebSocket';
import { useFileUpload } from './hooks/useFileUpload';
import { useVoiceRecording } from './hooks/useVoiceRecording';
import { useLocationShare } from './hooks/useLocationShare';
import { useMentions } from './hooks/useMentions';
import { MessageBubble } from './MessageBubble';
import { MentionPicker } from './MentionPicker';
import { VoiceRecorder } from '@imajin/input';
import { NameDisplaySelector, type NameDisplayPolicy } from './NameDisplaySelector';
import { useChatConfig } from './ChatProvider';

interface ChatProps {
  did: string;
  currentUserDid?: string;
  mediaUrl?: string;
  enableVoice?: boolean;
  enableMedia?: boolean;
  enableLocation?: boolean;
  onAccessDenied?: () => void;
  className?: string;

  // NEW — from EventChat consolidation
  compact?: boolean;                      // Tighter spacing for embed use
  footerText?: string;                    // e.g. "Visible to all ticket holders"
  enterToSend?: boolean;                  // Enter sends message (default: false, Enter = newline)
  showCapabilityGates?: boolean;          // Show 🔒 icons for locked features instead of hiding
  nameDisplayPolicy?: NameDisplayPolicy;
  displayPrefStorageKey?: string;         // localStorage key for attendee display pref (enables the selector)
  onDisplayPrefChange?: (pref: string) => void;
  resolveDisplayName?: (did: string, names: Record<string, string>, currentUserDid?: string) => string | undefined; // Custom name resolver
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
    senderSubtype: msg.senderSubtype,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: msg.content as any,
    contentType: msg.content.type ?? 'text',
    replyTo: msg.replyTo ?? null,
    linkPreviews: msg.linkPreviews ?? null,
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
  compact = false,
  footerText,
  enterToSend = false,
  showCapabilityGates = false,
  nameDisplayPolicy,
  displayPrefStorageKey,
  onDisplayPrefChange,
  resolveDisplayName,
}: ChatProps) {
  const access = useChatAccess(did);
  const { messages, hasMore, loadMore, isLoading, pushMessage, updateMessage, removeMessage, addReactionToMessage, removeReactionFromMessage } = useChatMessages(did);
  const { sendMessage, addReaction, removeReaction, editMessage, deleteMessage, markRead, isSending } =
    useChatActions(did);
  const { typingUsers, sendTyping, stopTyping, lastMessage } = useChatWebSocket(did);
  const { chatUrl, authUrl } = useChatConfig();
  const { uploadFile } = useFileUpload();
  const { sendVoice } = useVoiceRecording();
  const { shareLocation } = useLocationShare();

  const [composerText, setComposerText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; text: string; name: string } | null>(null);
  const [editingMsg, setEditingMsg] = useState<{ id: string; text: string } | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch conversation members for @mentions
  const [members, setMembers] = useState<{ did: string; role: string; name: string; handle: string }[]>([]);
  useEffect(() => {
    fetch(`${chatUrl}/api/d/${did}/members`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setMembers(data.members ?? []))
      .catch(() => setMembers([]));
  }, [chatUrl, did]);

  const isGroup = !did.includes(':dm:');

  const mentions = useMentions({
    text: composerText,
    setText: setComposerText,
    textareaRef,
    members,
    isGroup,
    authUrl: authUrl ?? '',
  });
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fire onAccessDenied when access resolves to denied
  useEffect(() => {
    if (!access.isLoading && !access.allowed && onAccessDenied) {
      onAccessDenied();
    }
  }, [access.isLoading, access.allowed, onAccessDenied]);

  // Mark as read when messages load
  useEffect(() => {
    if (!isLoading && messages.length > 0) {
      markRead();
    }
  }, [isLoading, messages.length, markRead]);

  // Push new WebSocket messages into the list; apply edits/deletes/reactions from other clients
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'new_message' && lastMessage.message) {
      pushMessage(lastMessage.message as ChatMessage);
      markRead();
    } else if (lastMessage.type === 'message_edited' && lastMessage.message) {
      const edited = lastMessage.message as ChatMessage;
      updateMessage(edited.id, { content: edited.content, editedAt: edited.editedAt });
    } else if (lastMessage.type === 'message_updated' && lastMessage.message) {
      const updated = lastMessage.message as ChatMessage;
      updateMessage(updated.id, { linkPreviews: updated.linkPreviews });
    } else if (lastMessage.type === 'message_deleted' && lastMessage.messageId) {
      removeMessage(lastMessage.messageId as string);
    } else if (lastMessage.type === 'reaction_added') {
      addReactionToMessage(lastMessage.messageId as string, lastMessage.emoji as string, lastMessage.senderDid as string);
    } else if (lastMessage.type === 'reaction_removed') {
      removeReactionFromMessage(lastMessage.messageId as string, lastMessage.emoji as string, lastMessage.senderDid as string);
    }
  }, [lastMessage, pushMessage, updateMessage, removeMessage, addReactionToMessage, removeReactionFromMessage]);

  // Set height every time text changes
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [composerText]);

  // Auto-scroll to bottom on new messages and initial load
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // Track whether user is near the bottom of the scroll container
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 80; // px from bottom
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Scroll on new messages (if user is near bottom) or initial load
  useEffect(() => {
    if (messages.length === 0) return;
    if (prevCountRef.current === 0) {
      // Initial load — snap to bottom instantly
      scrollToBottom('instant');
    } else if (messages.length > prevCountRef.current && isNearBottomRef.current) {
      scrollToBottom('smooth');
    }
    prevCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

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

  // Resolve sender DIDs to display names
  const senderDids = useMemo(
    () => Array.from(new Set(messages.map(m => m.senderDid).filter(d => d !== currentUserDid))),
    [messages, currentUserDid]
  );
  const didNames = useDidNames(senderDids);

  const handleSend = useCallback(async () => {
    const text = composerText.trim();
    if (!text || isSending) return;
    if (editingMsg) {
      await editMessage(editingMsg.id, { type: 'text', text });
      updateMessage(editingMsg.id, { content: { type: 'text', text }, editedAt: new Date().toISOString() });
      setEditingMsg(null);
    } else {
      await sendMessage(
        { type: 'text', text, mentions: mentions.mentions },
        replyTo ? { replyTo: replyTo.id } : undefined
      );
      setReplyTo(null);
    }
    setComposerText('');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    stopTyping();
  }, [composerText, isSending, editingMsg, replyTo, editMessage, sendMessage, stopTyping, mentions.mentions]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.handleKeyDown(e)) return;
    if (enterToSend && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setComposerText(e.target.value);
    mentions.handleChange(e);
    sendTyping();
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(stopTyping, 3000);
  };

  const handleReply = (msg: ChatMessage) => {
    const text = typeof msg.content === 'object' && 'text' in msg.content
      ? String(msg.content.text ?? '') : '';
    const name = didNames[msg.senderDid] || msg.senderDid.slice(-8);
    setReplyTo({ id: msg.id, text, name });
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

  const handleVoiceComplete = useCallback(async (blob: Blob, _durationMs: number) => {
    setVoiceSending(true);
    try {
      // Upload and transcribe, then put transcript in the text input
      const { transcript } = await sendVoice(blob);
      if (transcript) {
        setComposerText(prev => prev ? `${prev} ${transcript}` : transcript);
      }
    } catch {
      // error tracked in hook
    } finally {
      setVoiceSending(false);
      setVoiceActive(false);
    }
  }, [sendVoice]);

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

  const getComposerLabel = () => {
    if (editingMsg) return 'Editing message';
    if (replyTo) return `Replying to ${replyTo.name}`;
    return 'Replying';
  };

  const getReplyToName = (replyToMsg: ChatMessage | undefined) => {
    if (!replyToMsg) return undefined;

    if (replyToMsg.senderDid === currentUserDid) {
      return 'You';
    }

    return didNames[replyToMsg.senderDid] || replyToMsg.senderDid.slice(-8);
  };

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
    <div className={`flex flex-col h-full ${className ?? ''}`}>
      {/* Message list */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className={`flex-1 min-h-0 overflow-y-auto space-y-1 ${compact ? 'px-2 py-2' : 'px-4 py-3'}`}>
        <div ref={sentinelRef} />
        {isLoading && (
          <p className="text-center text-xs text-slate-400 py-2 animate-pulse">Loading…</p>
        )}

        {messages.map((msg, idx) => {
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const showSenderLabel = !prevMsg || prevMsg.senderDid !== msg.senderDid;
          const replyToMsg = msg.replyTo ? messageById.get(msg.replyTo) : undefined;
          const replyToSenderName = getReplyToName(replyToMsg);

          // Date separator: show when the date changes between messages
          const msgDate = new Date(msg.createdAt).toDateString();
          const prevDate = prevMsg ? new Date(prevMsg.createdAt).toDateString() : null;
          const showDateSeparator = !prevMsg || msgDate !== prevDate;

          const formatDateSeparator = (dateStr: string) => {
            const d = new Date(dateStr);
            const now = new Date();
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            if (d.toDateString() === now.toDateString()) return 'Today';
            if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
            const thisYear = d.getFullYear() === now.getFullYear();
            return d.toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              ...(thisYear ? {} : { year: 'numeric' }),
            });
          };

          return (
            <div key={msg.id} id={`msg-${msg.id}`}>
              {showDateSeparator && (
                <div className="flex items-center gap-3 my-3">
                  <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
                  <span className="text-xs text-gray-400 dark:text-gray-500 font-medium select-none">
                    {formatDateSeparator(msg.createdAt)}
                  </span>
                  <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
                </div>
              )}
              <MessageBubble
                message={toMsgShape(msg)}
                isOwn={msg.senderDid === currentUserDid}
                senderLabel={resolveDisplayName
                  ? (resolveDisplayName(msg.senderDid, didNames, currentUserDid) ?? didNames[msg.senderDid] ?? msg.senderDid.slice(-8))
                  : (didNames[msg.senderDid] ?? msg.senderDid.slice(-8))}
                showSenderLabel={showSenderLabel}
                onReply={() => handleReply(msg)}
                onEdit={() => handleEdit(msg)}
                onDelete={async () => {
                  removeMessage(msg.id);
                  deleteMessage(msg.id);
                }}
                reactions={computeReactions(msg.reactions, currentUserDid)}
                onReactionToggle={(emoji, reacted) => {
                  if (reacted) {
                    if (currentUserDid) removeReactionFromMessage(msg.id, emoji, currentUserDid);
                    removeReaction(msg.id, emoji);
                  } else {
                    if (currentUserDid) addReactionToMessage(msg.id, emoji, currentUserDid);
                    addReaction(msg.id, emoji);
                  }
                }}
                replyToMessage={replyToMsg ? toMsgShape(replyToMsg) : undefined}
                replyToSenderName={replyToSenderName}
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
      <div className={`flex flex-wrap items-end gap-1 border-t border-slate-200 dark:border-zinc-700 overflow-hidden ${compact ? 'py-1' : 'py-2'}`}>
        {(replyTo || editingMsg) && (
          <div className="flex items-start justify-between mb-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs w-full">
            <div className="min-w-0">
              <p className="font-semibold text-orange-500">
                {getComposerLabel()}
              </p>
              {replyTo && (
                <p className="truncate text-slate-500 dark:text-slate-400">
                  {(replyTo?.text ?? '').slice(0, 200)}
                </p>
              )}
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

        {(enableMedia || showCapabilityGates) && (
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />
        )}
        {!voiceActive && enableMedia && (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending}
            className="ima-btn"
            title="Attach file"
          >
            {'\uD83D\uDCCE'}
          </button>
        )}
        {!voiceActive && !enableMedia && showCapabilityGates && (
          <div
            className="p-1.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
            title="Verify your identity to send files"
          >
            🔒
          </div>
        )}
        {!voiceActive && (
          <div className="relative flex-1 min-w-0">
            <textarea
              ref={textareaRef}
              value={composerText}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder="Message…"
              rows={1}
              className={`w-full resize-none overflow-hidden bg-slate-100 dark:bg-zinc-800 rounded-2xl text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 outline-none ${compact ? 'px-2 py-1 min-h-8' : 'px-4 py-2 min-h-9'}`}
            />
            {mentions.isOpen && (
              <MentionPicker
                results={mentions.results}
                highlightedIndex={mentions.highlightedIndex}
                onSelect={mentions.selectMention}
                onClose={mentions.closePicker}
                isEveryone={isGroup}
                mediaUrl={mediaUrl}
              />
            )}
          </div>
        )}
        {!voiceActive && enableLocation && (
          <button
            onClick={handleShareLocation}
            disabled={isSending}
            className="ima-btn"
            title="Share location"
          >
            {'\uD83D\uDCCD'}
          </button>
        )}
        {!voiceActive && !enableLocation && showCapabilityGates && (
          <div
            className="p-1.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
            title="Verify your identity to share location"
          >
            🔒
          </div>
        )}
        {enableVoice && (
          <VoiceRecorder
            onRecordingStart={() => setVoiceActive(true)}
            onRecordingComplete={handleVoiceComplete}
            onCancel={() => setVoiceActive(false)}
            disabled={isSending}
          />
        )}
        {!enableVoice && showCapabilityGates && (
          <div
            className="p-1.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
            title="Verify your identity to send voice messages"
          >
            🔒
          </div>
        )}
        {voiceActive && voiceSending && (
          <span className="text-xs text-slate-400 flex-shrink-0">Sending…</span>
        )}
        <button
          onClick={handleSend}
          disabled={isSending || !composerText.trim()}
          className="ima-btn-primary"
          aria-label="Send"
        >
          <svg className="w-4 h-4 translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Footer */}
      {(footerText || (nameDisplayPolicy === 'attendee_choice' && displayPrefStorageKey)) && (
        <div className={`flex items-center justify-between ${compact ? 'mt-1' : 'mt-2'}`}>
          {footerText && <p className="text-xs text-gray-400">{footerText}</p>}
          {nameDisplayPolicy === 'attendee_choice' && displayPrefStorageKey && (
            <NameDisplaySelector
              policy={nameDisplayPolicy}
              storageKey={displayPrefStorageKey}
              onChange={onDisplayPrefChange}
            />
          )}
        </div>
      )}
    </div>
  );
}
