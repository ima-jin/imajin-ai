import React, { useState, useRef, useEffect } from 'react';

// Compact emoji set — most commonly used, organized by category
const EMOJI_DATA: Record<string, string[]> = {
  '😊 Smileys': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐'],
  '👋 Hands': ['👋', '🤚', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🙏', '💪'],
  '❤️ Hearts': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟'],
  '🎉 Objects': ['🎉', '🎊', '🎈', '🔥', '⭐', '🌟', '💫', '✨', '⚡', '💥', '🎵', '🎶', '🎸', '🎹', '🎤', '🎧', '📱', '💻', '🖥️', '📷', '🎮', '🕹️', '🎯', '🏆', '🥇', '🎪', '☕', '🍺', '🍕', '🍔'],
  '🚀 Travel': ['🚀', '✈️', '🚗', '🏠', '🌍', '🌎', '🌏', '🗺️', '🏔️', '🌋', '🏖️', '🌅', '🌄', '🌃', '🌉', '🎡', '🎢'],
  '🐾 Nature': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🌸', '🌹', '🌺', '🌻', '🌼', '🌷', '🌱', '🌲', '🌳', '🍀', '🍁', '🍂'],
};

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [activeCategory, setActiveCategory] = useState(Object.keys(EMOJI_DATA)[0]);
  const [search, setSearch] = useState('');
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

  const categories = Object.keys(EMOJI_DATA);

  // If searching, flatten all emojis (basic search by category name)
  const displayEmojis = search
    ? Object.entries(EMOJI_DATA)
        .filter(([cat]) => cat.toLowerCase().includes(search.toLowerCase()))
        .flatMap(([, emojis]) => emojis)
    : EMOJI_DATA[activeCategory] || [];

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 left-0 bg-[#1a1a1a] border border-gray-700 rounded-xl shadow-xl w-80 z-50 overflow-hidden"
    >
      {/* Search */}
      <div className="p-2 border-b border-gray-700">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="w-full px-3 py-1.5 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
          autoFocus
        />
      </div>

      {/* Category tabs */}
      {!search && (
        <div className="flex gap-1 px-2 py-1 border-b border-gray-700 overflow-x-auto">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`text-lg p-1 rounded transition-colors flex-shrink-0 ${
                activeCategory === cat ? 'bg-gray-700' : 'hover:bg-gray-800'
              }`}
              title={cat}
            >
              {cat.split(' ')[0]}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-0.5 p-2 max-h-48 overflow-y-auto">
        {displayEmojis.map((emoji, i) => (
          <button
            key={`${emoji}-${i}`}
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
            className="text-xl p-1 rounded hover:bg-gray-700 transition-colors text-center"
          >
            {emoji}
          </button>
        ))}
        {displayEmojis.length === 0 && (
          <div className="col-span-8 text-center text-gray-500 text-sm py-4">
            No emoji found
          </div>
        )}
      </div>
    </div>
  );
}
