'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface Message {
  id: string;
  conversationId: string;
  fromDid: string;
  content: { text: string };
  contentType: string;
  createdAt: string;
}

interface Profile {
  did: string;
  handle?: string;
  name?: string;
  type?: string;
  metadata?: Record<string, unknown>;
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

interface EventLobbyAccordionProps {
  eventId: string;
}

export function EventLobbyAccordion({ eventId }: EventLobbyAccordionProps) {
  const [hasTicket, setHasTicket] = useState<boolean | null>(null);
  const [lobbyConversationId, setLobbyConversationId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
  const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';

  // Check ticket ownership on mount
  useEffect(() => {
    async function checkTicket() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          if (data.hasTicket) {
            setHasTicket(true);
            setLobbyConversationId(data.lobbyConversationId);
          } else {
            setHasTicket(false);
          }
        } else {
          setHasTicket(false);
        }
      } catch (err) {
        setHasTicket(false);
      }
    }
    checkTicket();
  }, [eventId]);

  // Get current user's DID
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCurrentUserDid(data.did);
        }
      } catch (err) {
        console.error('Failed to fetch session:', err);
      }
    }
    fetchSession();
  }, [AUTH_SERVICE_URL]);

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    if (!hasTicket || !isExpanded) return;

    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
        credentials: 'include',
      });

      if (!res.ok) {
        if (res.status === 403) {
          setHasTicket(false);
          return;
        }
        throw new Error('Failed to load messages');
      }

      const data = await res.json();
      setMessages(data.messages || []);

      // Scroll to bottom on new messages
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, [eventId, hasTicket, isExpanded, CHAT_SERVICE_URL]);

  // Poll for messages when expanded
  useEffect(() => {
    if (!isExpanded || !hasTicket) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [fetchMessages, isExpanded, hasTicket]);

  // Fetch unread count when collapsed
  const fetchUnreadCount = useCallback(async () => {
    if (!lobbyConversationId || isExpanded) return;

    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/conversations/unread`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        const conversation = data.conversations?.find((c: { id: string }) => c.id === lobbyConversationId);
        setUnreadCount(conversation?.unread || 0);
      }
    } catch (err) {
      console.error('Failed to fetch unread count:', err);
    }
  }, [lobbyConversationId, isExpanded, CHAT_SERVICE_URL]);

  // Poll for unread count when collapsed
  useEffect(() => {
    if (isExpanded || !hasTicket || !lobbyConversationId) return;
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 3000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount, isExpanded, hasTicket, lobbyConversationId]);

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
            [did]: {
              did: data.did || did,
              handle: data.handle,
              name: data.name,
              type: data.type,
              metadata: data.metadata,
            },
          }));
        } else {
          setProfiles(prev => ({ ...prev, [did]: { did } }));
        }
      } catch {
        setProfiles(prev => ({ ...prev, [did]: { did } }));
      }
    });
  }, [messages, profiles, AUTH_SERVICE_URL]);

  // Send message
  const handleSend = async () => {
    if (!message.trim() || sending) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          content: { text: message.trim() },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send message');
      }

      setMessage('');
      await fetchMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const getDisplayName = (did: string): string => {
    const profile = profiles[did];
    if (!profile) return did.slice(0, 16) + '...';

    // Check if it's a soft DID (has tier: 'soft' in metadata or did starts with 'did:email:')
    const isSoftDid = did.startsWith('did:email:') || (profile.metadata as any)?.tier === 'soft';
    const prefix = isSoftDid ? '⚡ ' : '';

    if (profile.handle) return `${prefix}@${profile.handle}`;
    if (profile.name) return `${prefix}${profile.name}`;
    return did.slice(0, 16) + '...';
  };

  // Render nothing if no ticket or not authenticated
  if (hasTicket === false || hasTicket === null) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg overflow-hidden">
      {/* Collapsed Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/80 transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">💬</span>
          <span className="font-semibold text-lg">Event Chat</span>
        </div>
        <div className="flex items-center gap-3">
          {!isExpanded && unreadCount > 0 && (
            <span className="px-3 py-1 bg-orange-500 text-white text-xs font-semibold rounded-full">
              {unreadCount}
            </span>
          )}
          <span className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
            ▼
          </span>
        </div>
      </button>

      {/* Expanded Chat */}
      {isExpanded && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          {/* Error */}
          {error && (
            <div className="mx-6 mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
              {error}
              <button onClick={() => setError(null)} className="ml-2 underline">
                dismiss
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="h-[400px] overflow-y-auto px-6 py-4 space-y-4">
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

                return (
                  <div key={msg.id}>
                    {showDateDivider && (
                      <div className="flex items-center justify-center my-4">
                        <span className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-500">
                          {formatDateDivider(msg.createdAt)}
                        </span>
                      </div>
                    )}

                    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                      <div className="max-w-[70%]">
                        {/* Sender name */}
                        {!isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider) && (
                          <p className="text-xs text-orange-500 mb-1 ml-3 font-medium">
                            {getDisplayName(msg.fromDid)}
                          </p>
                        )}

                        <div
                          className={`px-4 py-2 rounded-2xl ${
                            isOwn
                              ? 'bg-orange-500 text-white rounded-br-md'
                              : 'bg-gray-100 dark:bg-gray-800 rounded-bl-md'
                          }`}
                        >
                          <p className="text-sm whitespace-pre-wrap">{msg.content.text}</p>
                        </div>

                        <p className={`text-xs text-gray-400 mt-1 ${isOwn ? 'text-right mr-1' : 'ml-3'}`}>
                          {formatMessageTime(msg.createdAt)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-end gap-2">
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
                disabled={!message.trim() || sending}
                className={`p-3 rounded-full transition ${
                  message.trim() && !sending
                    ? 'bg-orange-500 text-white hover:bg-orange-600'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-400'
                }`}
              >
                {sending ? '...' : '➤'}
              </button>
            </div>
            <p className="text-xs text-gray-400 text-center mt-2">
              Plaintext messages • Visible to all ticket holders
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
