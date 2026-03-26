'use client';

import { useState, useRef, useEffect } from 'react';
import { ReactionPicker } from './ReactionPicker';
import { LinkPreviewCard } from './LinkPreviewCard';
import { VoiceMessage } from './VoiceMessage';
import { MediaMessage } from './MediaMessage';
import { LocationMessage } from './LocationMessage';
import type { MessageContent } from './message-types';

const URL_REGEX = /(https?:\/\/[^\s<]+[^\s<.,;:!?"')\]])/g;

function linkifyText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(URL_REGEX);
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
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
    parts.push(text.slice(lastIndex));
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
  onScrollToMessage,
  mediaUrl = '',
}: MessageBubbleProps) {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extract text from content
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

  // Handle context menu (right-click still works)
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  // Handle hover with delay (400ms) for desktop
  const hoverTimer = useRef<NodeJS.Timeout | null>(null);
  const handleMouseEnter = () => {
    hoverTimer.current = setTimeout(() => {
      if (bubbleRef.current) {
        const rect = bubbleRef.current.getBoundingClientRect();
        setContextMenuPosition({ x: rect.right - 40, y: rect.top });
        setShowContextMenu(true);
      }
    }, 400);
  };
  const handleMouseLeave = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  // Handle long press for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    longPressTimer.current = setTimeout(() => {
      const touch = e.touches[0];
      setContextMenuPosition({ x: touch.clientX, y: touch.clientY });
      setShowContextMenu(true);
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
    }
  };

  // Close context menu on click outside or scroll
  useEffect(() => {
    if (!showContextMenu) return;

    const dismiss = () => setShowContextMenu(false);
    document.addEventListener('click', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [showContextMenu]);

  // Handle delete confirmation
  const handleDeleteClick = () => {
    setShowContextMenu(false);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    onDelete();
    setShowDeleteConfirm(false);
  };

  // If message is deleted, show placeholder
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
        {/* Sender handle */}
        {!isOwn && showSenderLabel && (
          <p className="text-xs text-amber-500 mb-1 ml-3 font-medium">{senderLabel}</p>
        )}

        <div
          ref={bubbleRef}
          onContextMenu={handleContextMenu}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="relative"
        >
          {/* Reply preview */}
          {replyToMessage && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => onScrollToMessage?.(message.replyTo!)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onScrollToMessage?.(message.replyTo!); }}
              className={`mb-1 px-3 py-1 rounded-lg text-xs cursor-pointer ${
                isOwn
                  ? 'bg-orange-400/30 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
              }`}
            >
              <p className="font-medium">↩ Reply to</p>
              <p className="truncate opacity-80">{replyToText.slice(0, 50)}{replyToText.length > 50 ? '...' : ''}</p>
            </div>
          )}

          <div
            className={`px-3 py-3 rounded-2xl ${
              isOwn
                ? 'bg-orange-500 text-white rounded-br-md'
                : 'bg-gray-100 dark:bg-gray-800 rounded-bl-md'
            }`}
          >
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
              // Default: text rendering with linkified URLs
              return text ? <p className="text-sm whitespace-pre-wrap">{linkifyText(text)}</p> : null;
            })()}

            {/* Link previews */}
            {message.linkPreviews && message.linkPreviews.length > 0 && (
              <div className="space-y-2 mt-2">
                {message.linkPreviews.map((preview, idx) => (
                  <LinkPreviewCard key={`${message.id}-preview-${idx}`} {...preview} />
                ))}
              </div>
            )}
          </div>

          {/* Context Menu */}
          {showContextMenu && (
            <div
              role="menu"
              className="fixed z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[150px]"
              style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setShowContextMenu(false);
                  onReply();
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Reply
              </button>
              {isOwn && (
                <button
                  onClick={() => {
                    setShowContextMenu(false);
                    onEdit();
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Edit
                </button>
              )}
              <button
                onClick={handleDeleteClick}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-red-600 dark:text-red-400"
              >
                Delete
              </button>
              <button
                onClick={() => {
                  setShowContextMenu(false);
                  setShowReactionPicker(true);
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                React
              </button>
            </div>
          )}

          {/* Reaction Picker */}
          {showReactionPicker && (
            <div className="relative">
              <ReactionPicker
                onSelect={(emoji) => {
                  const reaction = reactions.find((r) => r.emoji === emoji);
                  onReactionToggle(emoji, reaction?.reacted || false);
                }}
                onClose={() => setShowReactionPicker(false)}
              />
            </div>
          )}

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
            <div className="flex flex-wrap gap-1 mt-1">
              {reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  onClick={() => onReactionToggle(reaction.emoji, reaction.reacted)}
                  className={`px-2 py-0.5 rounded-full text-xs flex items-center gap-1 transition ${
                    reaction.reacted
                      ? 'bg-orange-500 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  <span>{reaction.emoji}</span>
                  <span>{reaction.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Timestamp and edited indicator */}
        <p className={`text-xs text-gray-400 mt-1 ${isOwn ? 'text-right mr-1' : 'ml-3'}`}>
          {formatMessageTime(message.createdAt)}
          {message.editedAt && <span className="ml-1 italic">(edited)</span>}
        </p>
      </div>
    </div>
  );
}
