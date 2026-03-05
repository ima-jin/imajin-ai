import React, { useRef, useEffect } from 'react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Theme override (default: dark) */
  theme?: 'light' | 'dark' | 'auto';
}

export function EmojiPicker({ onSelect, onClose, theme = 'dark' }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute bottom-full mb-2 left-0 z-50">
      <Picker
        data={data}
        onEmojiSelect={(emoji: any) => {
          onSelect(emoji.native);
          onClose();
        }}
        theme={theme}
        previewPosition="none"
        skinTonePosition="search"
        maxFrequentRows={2}
      />
    </div>
  );
}
