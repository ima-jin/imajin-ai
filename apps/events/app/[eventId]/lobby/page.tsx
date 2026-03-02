'use client';

import { useState, useEffect, useRef, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

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

export default function EventLobbyPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = use(params);
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTicket, setHasTicket] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
  const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';

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

  // Check ticket ownership
  useEffect(() => {
    async function checkTicket() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          setHasTicket(data.hasTicket);
          if (!data.hasTicket) {
            setLoading(false);
          }
        } else {
          setHasTicket(false);
          setLoading(false);
        }
      } catch (err) {
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
      setMessages(data.messages || []);
      setLoading(false);

      // Scroll to bottom on new messages
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      setLoading(false);
    }
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
            [did]: {
              did,
              handle: data.handle,
              name: data.name,
            },
          }));
        } else {
          setProfiles(prev => ({ ...prev, [did]: { did } }));
        }
      } catch {
        setProfiles(prev => ({ ...prev, [did]: { did } }));
      }
    });
  }, [messages, AUTH_SERVICE_URL]);

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
    if (profile.handle) return `@${profile.handle}`;
    if (profile.name) return profile.name;
    return did.slice(0, 16) + '...';
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto mt-20 text-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (hasTicket === false) {
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

  return (
    <div className="max-w-4xl mx-auto flex flex-col h-[calc(100vh-120px)]">
      {/* Header */}
      <div className="flex items-center gap-4 pb-4 border-b border-gray-200 dark:border-gray-700 mb-4">
        <Link
          href={`/${eventId}`}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
        >
          ← Back to Event
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">Event Lobby</h1>
          <p className="text-sm text-gray-500">Connect with other ticket holders</p>
        </div>
      </div>

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
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
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
      <div className="bg-white dark:bg-gray-900 pt-4 border-t border-gray-200 dark:border-gray-700">
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
  );
}
