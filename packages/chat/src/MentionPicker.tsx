'use client';

import { useEffect, useRef } from 'react';
import { EVERYONE_DID, type MentionResult } from './hooks/useMentions';

interface MentionPickerProps {
  results: MentionResult[];
  highlightedIndex: number;
  onSelect: (result: MentionResult) => void;
  onClose: () => void;
  mediaUrl?: string;
}

function resolveAvatarSrc(result: MentionResult, mediaUrl?: string): string | null {
  if (result.avatarAssetId && mediaUrl) {
    return `${mediaUrl}/api/media/${result.avatarAssetId}`;
  }
  if (result.avatarUrl) return result.avatarUrl;
  return null;
}

function roleBadgeClass(role?: string): string {
  switch (role?.toLowerCase()) {
    case 'owner':
      return 'bg-amber-900/50 text-amber-400 border-amber-800';
    case 'admin':
      return 'bg-red-900/50 text-red-400 border-red-800';
    case 'moderator':
      return 'bg-purple-900/50 text-purple-400 border-purple-800';
    case 'broadcast':
      return 'bg-red-900/50 text-red-400 border-red-800';
    default:
      return 'bg-gray-800 text-gray-400 border-gray-700';
  }
}

export function MentionPicker({
  results,
  highlightedIndex,
  onSelect,
  onClose,
  mediaUrl,
}: Readonly<MentionPickerProps>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightedRef = useRef<HTMLLIElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Scroll highlighted item into view when navigating with keyboard
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  if (results.length === 0) {
    return (
      <div
        ref={containerRef}
        className="absolute bottom-full left-0 mb-1 z-50 w-full bg-[#0a0a0a] border border-gray-800 rounded-lg shadow-xl overflow-hidden"
      >
        <div className="px-3 py-2.5 text-sm text-gray-500">No matches</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 mb-1 z-50 w-full bg-[#0a0a0a] border border-gray-800 rounded-lg shadow-xl overflow-hidden"
    >
      <ul className="max-h-60 overflow-y-auto">
        {results.map((result, index) => {
          const isHighlighted = index === highlightedIndex;
          const isEveryoneRow = result.did === EVERYONE_DID;
          const avatarSrc = resolveAvatarSrc(result, mediaUrl);

          return (
            <li key={result.did} ref={isHighlighted ? highlightedRef : undefined}>
              <button
                type="button"
                onClick={() => onSelect(result)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  isHighlighted ? 'bg-gray-800/80' : 'hover:bg-gray-800/50'
                }`}
              >
                {isEveryoneRow ? (
                  <div className="w-8 h-8 rounded-full bg-red-900/30 flex items-center justify-center text-sm shrink-0 border border-red-900/50">
                    🔔
                  </div>
                ) : avatarSrc ? (
                  <img
                    src={avatarSrc}
                    alt=""
                    className="w-8 h-8 rounded-full object-cover border border-gray-800 shrink-0"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs text-gray-500 shrink-0">
                    {result.name?.[0]?.toUpperCase() ?? '?'}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">
                      {isEveryoneRow ? (
                        <span className="text-white">Everyone</span>
                      ) : (
                        <span className="text-white">{result.name || result.handle}</span>
                      )}
                    </p>
                    {result.role && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wide ${roleBadgeClass(result.role)}`}
                      >
                        {result.role}
                      </span>
                    )}
                  </div>
                  <p className="text-xs truncate">
                    {isEveryoneRow ? (
                      <span className="text-red-400">@everyone</span>
                    ) : (
                      <span className="text-amber-400">@{result.handle}</span>
                    )}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
