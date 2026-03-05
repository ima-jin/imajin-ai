import React, { useState } from 'react';

export type InputFeature = 'voice' | 'emoji' | 'files';

export interface ImajinInputProps {
  onSubmit: (text: string) => void | Promise<void>;
  onMediaReady?: (file: File) => void | Promise<void>;
  features?: InputFeature[];
  placeholder?: string;
  disabled?: boolean;
}

export function ImajinInput({
  onSubmit,
  onMediaReady,
  features = [],
  placeholder = 'Type a message...',
  disabled = false,
}: ImajinInputProps) {
  const [value, setValue] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 w-full">
      {features.includes('emoji') && (
        <button
          type="button"
          title="Emoji (coming soon)"
          className="p-2 text-gray-500 hover:text-orange-400 transition-colors"
          disabled
        >
          😊
        </button>
      )}

      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 transition-colors"
      />

      {features.includes('files') && (
        <label
          title="Attach file (coming soon)"
          className="p-2 text-gray-500 hover:text-orange-400 transition-colors cursor-pointer"
        >
          <input
            type="file"
            className="sr-only"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file && onMediaReady) onMediaReady(file);
            }}
          />
          📎
        </label>
      )}

      {features.includes('voice') && (
        <button
          type="button"
          title="Voice input (coming soon)"
          className="p-2 text-gray-500 hover:text-orange-400 transition-colors"
          disabled
        >
          🎙️
        </button>
      )}

      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Send
      </button>
    </form>
  );
}
