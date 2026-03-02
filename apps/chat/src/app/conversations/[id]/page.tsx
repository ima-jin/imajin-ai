'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { useWebSocket } from '@/hooks/useWebSocket';
import { MessageBubble } from '@/app/components/MessageBubble';
import { TypingIndicator } from '@/app/components/TypingIndicator';
import { FileUpload } from '@/app/components/FileUpload';
import { MessageMedia } from '@/app/components/MessageMedia';

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
  mediaMeta?: any;
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

export default function MessageThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
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
    mediaMeta: any;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef<number>(0);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const { lastMessage: wsMessage, isConnected: wsConnected, subscribe: wsSubscribe, sendTyping, sendStopTyping } = useWebSocket();

  const conversationId = params.id;

  // Fetch conversation info and mark as read
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
        // Conversation info is optional for display
      }
    }

    async function markAsRead() {
      try {
        await fetch(`/api/conversations/${conversationId}/read`, {
          method: 'POST',
        });
      } catch {
        // Silently fail - not critical
      }
    }

    fetchConversation();
    markAsRead();

    // Mark as read whenever the window gains focus
    const handleFocus = () => {
      markAsRead();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [identity, conversationId]);

  // Resolve handles for message senders
  useEffect(() => {
    if (!messages.length) return;
    const unknownDids = Array.from(new Set(messages.map(m => m.fromDid))).filter(d => !handleMap[d]);
    if (!unknownDids.length) return;

    unknownDids.forEach(async (did) => {
      try {
        const res = await fetch(`/api/lookup/${encodeURIComponent(did)}`);
        if (res.ok) {
          const data = await res.json();
          const label = data.handle ? `@${data.handle}` : data.name || did.slice(0, 16) + '...';
          setHandleMap(prev => ({ ...prev, [did]: label }));
        } else {
          setHandleMap(prev => ({ ...prev, [did]: did.slice(0, 16) + '...' }));
        }
      } catch {
        setHandleMap(prev => ({ ...prev, [did]: did.slice(0, 16) + '...' }));
      }
    });
  }, [messages]);

  // Fetch reactions for all messages
  useEffect(() => {
    if (!identity || !messages.length) return;

    messages.forEach(async (msg) => {
      if (msg.deletedAt) return;
      try {
        const res = await fetch(`/api/messages/${msg.id}/reactions`);
        if (res.ok) {
          const data = await res.json();
          setMessageReactions(prev => ({ ...prev, [msg.id]: data.reactions || [] }));
        }
      } catch {
        // Ignore reaction fetch errors
      }
    });
  }, [identity, messages]);

  // Fetch messages
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

      // Auto-scroll if new messages arrived
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
  }, [identity, conversationId]);

  // Initial fetch
  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Subscribe to WebSocket for this conversation
  useEffect(() => {
    if (!identity || !conversationId) return;
    wsSubscribe(conversationId);
  }, [identity, conversationId, wsSubscribe]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (!wsMessage || !wsMessage.type) return;

    if (wsMessage.type === 'new_message' && wsMessage.message) {
      const msg = wsMessage.message as Message;
      if (msg.conversationId !== conversationId) return;

      setMessages(prev => {
        // Deduplicate
        if (prev.some(m => m.id === msg.id)) return prev;
        const updated = [...prev, msg];
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        return updated;
      });
    } else if (wsMessage.type === 'message_edited' && wsMessage.message) {
      const msg = wsMessage.message as Message;
      if (msg.conversationId !== conversationId) return;

      setMessages(prev => prev.map(m => m.id === msg.id ? msg : m));
    } else if (wsMessage.type === 'message_deleted' && wsMessage.message) {
      const msg = wsMessage.message as Message;
      if (msg.conversationId !== conversationId) return;

      setMessages(prev => prev.map(m => m.id === msg.id ? msg : m));
    } else if ((wsMessage.type === 'reaction_added' || wsMessage.type === 'reaction_removed') && wsMessage.messageId) {
      if (wsMessage.reactions) {
        setMessageReactions(prev => ({
          ...prev,
          [wsMessage.messageId]: wsMessage.reactions,
        }));
      }
    } else if (wsMessage.type === 'user_typing' && wsMessage.conversationId === conversationId) {
      setTypingUsers(prev => {
        // Don't show own typing indicator
        if (wsMessage.did === identity?.did) return prev;
        // Deduplicate
        if (prev.some(u => u.did === wsMessage.did)) return prev;
        return [...prev, { did: wsMessage.did, name: wsMessage.name || null }];
      });
    } else if (wsMessage.type === 'user_stop_typing' && wsMessage.conversationId === conversationId) {
      setTypingUsers(prev => prev.filter(u => u.did !== wsMessage.did));
    }
  }, [wsMessage, conversationId, identity]);

  // Fall back to polling if WebSocket is disconnected
  useEffect(() => {
    if (!identity || !conversationId || wsConnected) return;
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [identity, conversationId, fetchMessages, wsConnected]);

  // Handle file upload completion
  const handleUploadComplete = (data: {
    mediaType: 'image' | 'file';
    mediaPath: string;
    mediaMeta: any;
  }) => {
    setUploadedMedia(data);
  };

  const handleUploadError = (errorMsg: string) => {
    setError(errorMsg);
  };

  // Send or edit message
  const handleSend = async () => {
    if ((!message.trim() && !uploadedMedia) || sending) return;

    // Stop typing indicator
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (conversationId) {
      sendStopTyping(conversationId);
    }

    setSending(true);
    try {
      if (editingMessage) {
        // Edit existing message
        const res = await fetch(`/api/conversations/${conversationId}/messages/${editingMessage.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { type: 'text', text: message.trim() },
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to edit');
        }

        setEditingMessage(null);
        setMessage('');
        await fetchMessages();
      } else {
        // Send new message
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

  // Paste handler for images
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          // Upload the file
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
          } catch (err) {
            handleUploadError('Failed to upload pasted image');
          }
        }
      }
    }
  }, [conversationId]);

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = useCallback(async (e: React.DragEvent) => {
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
    } catch (err) {
      handleUploadError('Failed to upload file');
    }
  }, [conversationId]);

  // Attach paste handler
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

  // Handle typing indicator on input change
  const handleMessageChange = (text: string) => {
    setMessage(text);

    if (!text.trim() || !conversationId) return;

    // Debounced typing indicator (max 1 per 2s)
    const now = Date.now();
    if (now - lastTypingSentRef.current > 2000) {
      sendTyping(conversationId, identity?.name || null);
      lastTypingSentRef.current = now;
    }

    // Reset stop typing timer
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Send stop typing after 3s of no input
    typingTimeoutRef.current = setTimeout(() => {
      if (conversationId) {
        sendStopTyping(conversationId);
      }
    }, 3000);
  };

  // Clean up typing timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
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
      // Highlight briefly
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
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100vh-200px)]">
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
            {conversation?.name || (conversation?.type === 'direct' ? 'Direct Message' : 'Conversation')}
          </h1>
          {conversation?.type === 'group' && conversation?.participantCount && (
            <p className="text-xs text-gray-500 mt-1">
              {conversation.participantCount} {conversation.participantCount === 1 ? 'member' : 'members'}
            </p>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="my-2 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={chatAreaRef}
        className="flex-1 overflow-y-auto py-4 space-y-4"
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
              new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();

            const showSenderLabel = !isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider);

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
                    onReactionToggle={(emoji, reacted) => handleReactionToggle(msg.id, emoji, reacted)}
                    replyToMessage={replyTo}
                    onScrollToMessage={scrollToMessage}
                  />
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        {/* Typing Indicator */}
        <TypingIndicator typingUsers={typingUsers} />

        {/* Reply preview */}
        {replyToMessage && (
          <div className="mb-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Replying to {handleMap[replyToMessage.fromDid] || replyToMessage.fromDid.slice(0, 16) + '...'}
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

        {/* Edit preview */}
        {editingMessage && (
          <div className="mb-2 p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-between">
            <p className="text-xs font-medium text-blue-600 dark:text-blue-400">Editing message</p>
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

        {/* Uploaded media preview */}
        {uploadedMedia && (
          <div className="mb-2 flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {uploadedMedia.mediaType === 'image' ? '🖼️' : '📎'} {uploadedMedia.mediaMeta.originalName}
            </span>
            <button
              onClick={() => setUploadedMedia(null)}
              className="ml-auto text-gray-500 hover:text-red-500"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <FileUpload
            conversationId={conversationId}
            onUploadComplete={handleUploadComplete}
            onUploadError={handleUploadError}
          />
          <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2">
            <textarea
              value={message}
              onChange={(e) => handleMessageChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              className="w-full bg-transparent resize-none outline-none text-sm max-h-32"
              rows={1}
            />
          </div>
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
        </div>
        <p className="text-xs text-gray-400 text-center mt-2">🔒 End-to-end encrypted</p>
      </div>
    </div>
  );
}
