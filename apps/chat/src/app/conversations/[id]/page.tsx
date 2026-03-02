'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { useWebSocket } from '@/hooks/useWebSocket';
import { FileUpload } from '@/app/components/FileUpload';
import { MessageMedia } from '@/app/components/MessageMedia';

interface Message {
  id: string;
  conversationId: string;
  fromDid: string;
  content: { type: string; text: string };
  contentType: string;
  replyTo: string | null;
  createdAt: string;
  editedAt: string | null;
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
  const [uploadedMedia, setUploadedMedia] = useState<{
    mediaType: 'image' | 'file';
    mediaPath: string;
    mediaMeta: any;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const { lastMessage: wsMessage, isConnected: wsConnected, subscribe: wsSubscribe } = useWebSocket();

  const conversationId = params.id;

  // Fetch conversation info
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
    fetchConversation();
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

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    if (!identity || !conversationId) return;

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) {
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
    if (!wsMessage || wsMessage.type !== 'new_message' || !wsMessage.message) return;
    const msg = wsMessage.message as Message;
    if (msg.conversationId !== conversationId) return;

    setMessages(prev => {
      // Deduplicate
      if (prev.some(m => m.id === msg.id)) return prev;
      const updated = [...prev, msg];
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
      return updated;
    });
  }, [wsMessage, conversationId]);

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

  // Send message
  const handleSend = async () => {
    if ((!message.trim() && !uploadedMedia) || sending) return;

    setSending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { type: 'text', text: message.trim() || '' },
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

      setMessage('');
      setUploadedMedia(null);
      // Immediately fetch to show new message
      await fetchMessages();
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

            // Extract text from content
            const text =
              typeof msg.content === 'object' && msg.content?.text
                ? msg.content.text
                : typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content);

            return (
              <div key={msg.id}>
                {showDateDivider && (
                  <div className="flex items-center justify-center my-4">
                    <span className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-500">
                      {formatDateDivider(msg.createdAt)}
                    </span>
                  </div>
                )}

                {msg.contentType === 'system' ? (
                  <div className="text-center text-xs text-gray-500 my-2">{text}</div>
                ) : (
                  <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%]`}>
                      {/* Sender handle */}
                      {!isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider) && (
                        <p className="text-xs text-amber-500 mb-1 ml-3 font-medium">
                          {handleMap[msg.fromDid] || msg.fromDid.slice(0, 16) + '...'}
                        </p>
                      )}

                      <div
                        className={`px-4 py-2 rounded-2xl ${
                          isOwn
                            ? 'bg-orange-500 text-white rounded-br-md'
                            : 'bg-gray-100 dark:bg-gray-800 rounded-bl-md'
                        }`}
                      >
                        <p className="text-sm whitespace-pre-wrap">{text}</p>
                        {msg.mediaType && msg.mediaPath && msg.mediaMeta && (
                          <MessageMedia
                            mediaType={msg.mediaType}
                            mediaPath={msg.mediaPath}
                            mediaMeta={msg.mediaMeta}
                          />
                        )}
                      </div>

                      <p className={`text-xs text-gray-400 mt-1 ${isOwn ? 'text-right mr-1' : 'ml-3'}`}>
                        {formatMessageTime(msg.createdAt)}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
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
              onChange={(e) => setMessage(e.target.value)}
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
            {sending ? '...' : '➤'}
          </button>
        </div>
        <p className="text-xs text-gray-400 text-center mt-2">🔒 End-to-end encrypted</p>
      </div>
    </div>
  );
}
