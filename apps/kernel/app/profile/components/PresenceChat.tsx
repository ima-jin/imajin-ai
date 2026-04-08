'use client';

import { useState, useRef, useEffect, useCallback, FormEvent } from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ToolEvent {
  type: 'tool_call' | 'tool_result';
  name: string;
  data: unknown;
  timestamp: number;
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
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, toolEvents]);

  const sendMessage = useCallback(async (userText: string) => {
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: userText };
    const assistantId = crypto.randomUUID();

    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setError(null);

    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
    abortRef.current = new AbortController();

    try {
      const res = await fetch(`/profile/api/profile/${encodeURIComponent(targetDid)}/stream`, {
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

      // Add empty assistant message
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '' }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === 'text') {
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId
                    ? { ...m, content: m.content + event.text }
                    : m
                )
              );
            } else if (event.type === 'tool_call') {
              setToolEvents(prev => [...prev, {
                type: 'tool_call',
                name: event.name,
                data: event.args,
                timestamp: Date.now(),
              }]);
            } else if (event.type === 'tool_result') {
              setToolEvents(prev => [...prev, {
                type: 'tool_result',
                name: event.name,
                data: event.result,
                timestamp: Date.now(),
              }]);
            } else if (event.type === 'error') {
              setError(event.message);
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Something went wrong');
      setMessages(prev => prev.filter(m => m.id !== assistantId));
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
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowDebug(d => !d)}
              className={`text-xs px-2 py-1 rounded transition ${
                showDebug ? 'bg-amber-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
              title="Toggle tool debug"
            >
              🔧
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition p-1"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
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
                <p className="whitespace-pre-wrap text-left">{msg.content || '\u200B'}</p>
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

        {/* Debug panel */}
        {showDebug && toolEvents.length > 0 && (
          <div className="border-t border-gray-800 bg-gray-900/80 max-h-[200px] overflow-y-auto px-4 py-2">
            <p className="text-gray-500 text-xs font-mono mb-1">Tool Activity</p>
            {toolEvents.map((evt, i) => (
              <div key={i} className="text-xs font-mono mb-2">
                <span className={evt.type === 'tool_call' ? 'text-blue-400' : 'text-green-400'}>
                  {evt.type === 'tool_call' ? '→' : '←'} {evt.name}
                </span>
                <pre className="text-gray-500 mt-0.5 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(evt.data, null, 2).slice(0, 1000)}
                </pre>
              </div>
            ))}
          </div>
        )}

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
