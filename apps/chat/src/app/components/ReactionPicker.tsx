'use client';

import { useEffect, useRef } from 'react';

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position?: { x: number; y: number };
}

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export function ReactionPicker({ onSelect, onClose, position }: ReactionPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={pickerRef}
      className="absolute z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-2 flex gap-1"
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => {
            onSelect(emoji);
            onClose();
          }}
          className="w-10 h-10 flex items-center justify-center text-xl hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
