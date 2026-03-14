'use client';

import { useState, useRef, useEffect, useCallback, FormEvent } from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface PresenceChatProps {
  targetDid: string;
  targetName: string;
  targetHandle?: string;
  onClose: () => void;
}

export function PresenceChat({ targetDid, targetName, targetHandle, onClose }: PresenceChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = useCallback(async (userText: string) => {
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: userText };
    const assistantMsg: Message = { id: crypto.randomUUID(), role: 'assistant', content: '' };

    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setError(null);

    // Build conversation history for the API (only role + content, no SDK metadata)
    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

    abortRef.current = new AbortController();

    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(targetDid)}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      if (!res.body) throw new Error('No response body');

      // Add empty assistant message, then stream into it
      setMessages(prev => [...prev, assistantMsg]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        setMessages(prev =>
          prev.map(m =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content + chunk }
              : m
          )
        );
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Something went wrong');
      // Remove the empty assistant message on error
      setMessages(prev => prev.filter(m => m.id !== assistantMsg.id));
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [messages, targetDid]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    sendMessage(text);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Chat panel */}
      <div className="relative w-full max-w-lg h-[600px] max-h-[85vh] bg-gray-950 border border-gray-800 rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div>
            <h3 className="text-white text-sm font-medium">
              Asking {targetName}&apos;s presence
            </h3>
            <p className="text-gray-500 text-xs">
              AI representation · not {targetHandle ? `@${targetHandle}` : targetName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition p-1"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && !isLoading && (
            <div className="text-center text-gray-600 text-sm mt-8">
              <p className="text-2xl mb-2">🟠</p>
              <p>Ask {targetName} anything.</p>
              <p className="text-xs text-gray-700 mt-1">
                Responses come from their configured presence.
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content || '\u200B'}</p>
              </div>
            </div>
          ))}

          {isLoading && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex justify-start">
              <div className="bg-gray-800 text-gray-400 px-3 py-2 rounded-xl rounded-bl-sm text-sm">
                <span className="animate-pulse">Thinking...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-center">
              <p className="text-red-400 text-xs bg-red-950/50 px-3 py-1 rounded">
                {error}
              </p>
            </div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-gray-800">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask ${targetName}...`}
              className="flex-1 bg-gray-900 text-white text-sm px-3 py-2 rounded-lg border border-gray-700 focus:border-gray-500 focus:outline-none placeholder-gray-500"
              disabled={isLoading}
              autoFocus
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="px-4 py-2 bg-white text-black text-sm font-medium rounded-lg hover:bg-gray-200 transition disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Ask
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
