'use client';

import { useState, useRef, useEffect } from 'react';
import { ActionSheet } from '@imajin/ui';
import { LinkPreviewCard } from './LinkPreviewCard';
import { VoiceMessage } from './VoiceMessage';
import { MediaMessage } from './MediaMessage';
import { LocationMessage } from './LocationMessage';
import type { MessageContent } from './message-types';

const URL_REGEX = /(https?:\/\/[^\s<]+[^\s<.,;:!?"')\]])/g;
const MENTION_DISPLAY_REGEX = /@([a-zA-Z0-9_-]+)/g;

function renderTextSegment(text: string, keyPrefix: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(MENTION_DISPLAY_REGEX);
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={`${keyPrefix}-mention-${match.index}`} className="text-amber-400 font-medium">
        @{match[1]}
      </span>
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function linkifyText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(URL_REGEX);
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderTextSegment(text.slice(lastIndex, match.index), `seg-${lastIndex}`));
    }
    const url = match[1];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 underline break-all"
      >
        {url}
      </a>
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(...renderTextSegment(text.slice(lastIndex), `seg-${lastIndex}`));
  }
  return parts;
}

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
  content: MessageContent | { type: string; text: string };
  contentType: string;
  replyTo: string | null;
  linkPreviews?: LinkPreview[] | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface Reaction {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  senderLabel: string;
  showSenderLabel: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  reactions: Reaction[];
  onReactionToggle: (emoji: string, reacted: boolean) => void;
  replyToMessage?: Message | null;
  replyToSenderName?: string;
  onScrollToMessage?: (messageId: string) => void;
  /** Base URL for the media service (e.g. process.env.NEXT_PUBLIC_MEDIA_URL). Passed down to VoiceMessage and MediaMessage. */
  mediaUrl?: string;
}

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export function MessageBubble({
  message,
  isOwn,
  senderLabel,
  showSenderLabel,
  onReply,
  onEdit,
  onDelete,
  reactions,
  onReactionToggle,
  replyToMessage,
  replyToSenderName,
  onScrollToMessage,
  mediaUrl = '',
}: MessageBubbleProps) {
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const text =
    typeof message.content === 'object' && (message.content as any)?.text
      ? (message.content as any).text
      : typeof message.content === 'string'
        ? message.content
        : '';

  const replyToText =
    replyToMessage && typeof replyToMessage.content === 'object' && (replyToMessage.content as any)?.text
      ? (replyToMessage.content as any).text
      : replyToMessage && typeof replyToMessage.content === 'string'
        ? replyToMessage.content
        : '';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowActionSheet(true);
  };

  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      setShowActionSheet(true);
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  const handleDeleteClick = () => {
    setShowActionSheet(false);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    onDelete();
    setShowDeleteConfirm(false);
  };

  if (message.deletedAt) {
    return (
      <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
        <div className="max-w-[90%]">
          <div className="px-3 py-3 rounded-2xl bg-gray-100 dark:bg-gray-800 opacity-60">
            <p className="text-sm italic text-gray-500">This message was deleted</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[90%]">
        <div
          onContextMenu={handleContextMenu}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="relative"
        >

          <div
            className={`px-3 py-3 rounded-2xl ${isOwn
                ? 'bg-orange-500 text-white rounded-br-none'
                : 'bg-gray-100 dark:bg-gray-800 rounded-bl-none'
              }`}
          >
            {/* Sender handle */}
            {!isOwn && showSenderLabel && (
              <p className="text-xs text-amber-500 mb-1 font-medium">{senderLabel}</p>
            )}

            {/* Reply preview */}
            {replyToMessage && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => onScrollToMessage?.(message.replyTo!)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onScrollToMessage?.(message.replyTo!); }}
                className={`msg-bubble-reply-to my-1 px-2 py-1 rounded-lg text-xs cursor-pointer bg-black/30 rounded-bl-none rounded-br-none border-white/50 border-l-4 text-white ${isOwn
                    ? ''
                    : ''
                  }`}
              >
                <p className="font-medium">{replyToSenderName || '...'}</p>
                <p className="truncate opacity-80">{replyToText.slice(0, 200)}{replyToText.length > 200 ? '...' : ''}</p>
              </div>
            )}

            {/* Rich content rendering */}
            {(() => {
              const ct = message.contentType || (message.content as any)?.type;
              if (ct === 'voice') {
                const c = message.content as any;
                return (
                  <VoiceMessage
                    assetId={c.assetId}
                    transcript={c.transcript}
                    durationMs={c.durationMs}
                    waveform={c.waveform}
                    isOwn={isOwn}
                    mediaUrl={mediaUrl}
                  />
                );
              }
              if (ct === 'media') {
                const c = message.content as any;
                return (
                  <MediaMessage
                    assetId={c.assetId}
                    filename={c.filename}
                    mimeType={c.mimeType}
                    size={c.size}
                    width={c.width}
                    height={c.height}
                    caption={c.caption}
                    isOwn={isOwn}
                    mediaUrl={mediaUrl}
                  />
                );
              }
              if (ct === 'location') {
                const c = message.content as any;
                return (
                  <LocationMessage
                    lat={c.lat}
                    lng={c.lng}
                    label={c.label}
                    accuracy={c.accuracy}
                    isOwn={isOwn}
                  />
                );
              }
              return text ? <p className="text-sm whitespace-pre-wrap">{linkifyText(text)}</p> : null;
            })()}

            {/* Timestamp and edited indicator */}
            <p className="text-right message-bubble-time">
              {formatMessageTime(message.createdAt)}
              {message.editedAt && <span className="italic">(edited)</span>}
            </p>

            {/* Link previews */}
            {message.linkPreviews && message.linkPreviews.length > 0 && (
              <div className="space-y-2 mt-2">
                {message.linkPreviews.map((preview, idx) => (
                  <LinkPreviewCard key={`${message.id}-preview-${idx}`} {...preview} />
                ))}
              </div>
            )}
          </div>

          {/* ActionSheet */}
          <ActionSheet open={showActionSheet} onClose={() => setShowActionSheet(false)} title="Message">
            <ActionSheet.Reactions
              emojis={REACTION_EMOJIS}
              onSelect={(emoji) => {
                const reaction = reactions.find((r) => r.emoji === emoji);
                onReactionToggle(emoji, reaction?.reacted || false);
                setShowActionSheet(false);
              }}
            />
            <ActionSheet.Actions>
              <ActionSheet.Action icon="↩" label="Reply" onPress={() => { setShowActionSheet(false); onReply(); }} />
              {isOwn && (
                <ActionSheet.Action icon="✏️" label="Edit" onPress={() => { setShowActionSheet(false); onEdit(); }} />
              )}
              {text && (
                <ActionSheet.Action icon="📋" label="Copy text" onPress={() => { navigator.clipboard.writeText(text); setShowActionSheet(false); }} />
              )}
            </ActionSheet.Actions>
            <ActionSheet.Actions>
              <ActionSheet.Action icon="🗑" label="Delete" onPress={handleDeleteClick} variant="danger" />
            </ActionSheet.Actions>
          </ActionSheet>

          {/* Delete Confirmation */}
          {showDeleteConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
                <h3 className="text-lg font-semibold mb-2">Delete message?</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  This will permanently delete this message for everyone.
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDelete}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reactions */}
          {reactions.length > 0 && (
            <div className={`reactions-wrapper flex gap-1 ml-1.5 mr-1.5 ${isOwn ? 'justify-start' : 'justify-end'}`}>
              {reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  onClick={() => onReactionToggle(reaction.emoji, reaction.reacted)}
                  className={`px-1 py-0.5 rounded-full text-xs flex items-center gap-1 border border-white dark:border-black transition ${reaction.reacted
                      ? 'bg-orange-500 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'
                    }`}
                >
                  <span className="reaction-icon">{reaction.emoji}</span>
                  {reaction.count > 1 && <span className="reaction-count">{reaction.count}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
