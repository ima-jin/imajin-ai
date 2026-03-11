'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useChatConfig } from '../ChatProvider';

export interface ChatMessage {
  id: string;
  did: string;
  senderDid: string;
  content: { type: string; text?: string; [key: string]: unknown };
  replyTo?: string;
  reactions?: { emoji: string; senderDid: string }[];
  createdAt: string;
  editedAt?: string;
}

interface UseChatMessagesResult {
  messages: ChatMessage[];
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  error: Error | null;
  pushMessage: (message: ChatMessage) => void;
}

export function useChatMessages(did: string): UseChatMessagesResult {
  const { chatUrl } = useChatConfig();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<string | undefined>(undefined);
  const initialLoadDone = useRef(false);

  const fetchMessages = useCallback(async (before?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (before) params.set('before', before);
      const res = await fetch(
        `${chatUrl}/api/d/${did}/messages?${params}`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
      const data = await res.json();
      const fetched: ChatMessage[] = data.messages ?? data;
      // Oldest first
      const sorted = [...fetched].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      if (before) {
        setMessages(prev => [...sorted, ...prev]);
      } else {
        setMessages(sorted);
      }
      setHasMore(data.hasMore ?? fetched.length === 50);
      if (sorted.length > 0) {
        cursorRef.current = sorted[0].id;
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [chatUrl, did]);

  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      cursorRef.current = undefined;
      setMessages([]);
      fetchMessages();
    }
  }, [fetchMessages]);

  // Reset when did changes
  useEffect(() => {
    initialLoadDone.current = false;
    cursorRef.current = undefined;
    setMessages([]);
    setHasMore(false);
    setError(null);
    fetchMessages();
  }, [did]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      fetchMessages(cursorRef.current);
    }
  }, [isLoading, hasMore, fetchMessages]);

  const pushMessage = useCallback((message: ChatMessage) => {
    setMessages(prev => {
      if (prev.some(m => m.id === message.id)) return prev;
      return [...prev, message];
    });
  }, []);

  return { messages, hasMore, loadMore, isLoading, error, pushMessage };
}
