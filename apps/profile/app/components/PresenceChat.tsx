'use client';

import { useChat } from '@ai-sdk/react';
import { useRef, useEffect } from 'react';

interface PresenceChatProps {
  targetDid: string;
  targetName: string;
  targetHandle?: string;
  onClose: () => void;
}

export function PresenceChat({ targetDid, targetName, targetHandle, onClose }: PresenceChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, input, handleInputChange, handleSubmit, isLoading, error } = useChat({
    api: `/api/profile/${encodeURIComponent(targetDid)}/stream`,
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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
          {messages.length === 0 && (
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
                <p className="whitespace-pre-wrap">{msg.content}</p>
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
                {error.message || 'Something went wrong'}
              </p>
            </div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-gray-800">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={handleInputChange}
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
