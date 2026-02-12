'use client';

import type { Participant } from '@/db';
import { formatDuration } from '@/lib/utils';

interface ParticipantRowProps {
  participant: Participant;
  position: number;
  showControls?: boolean;
  onStatusChange?: (id: string, status: string) => void;
}

export function ParticipantRow({
  participant,
  position,
  showControls = false,
  onStatusChange,
}: ParticipantRowProps) {
  const isComplete = participant.status === 'complete';
  const isSkipped = participant.status === 'skipped';
  const isActive = participant.status === 'active';
  const isDone = isComplete || isSkipped;

  // Calculate duration if complete
  let duration: string | null = null;
  if (participant.turnStart && participant.turnEnd) {
    const ms = new Date(participant.turnEnd).getTime() - new Date(participant.turnStart).getTime();
    duration = formatDuration(ms);
  }

  return (
    <div
      className={`flex items-center justify-between p-4 border-b border-gray-700 ${
        isDone ? 'opacity-50' : ''
      } ${isActive ? 'bg-orange-500/20 border-orange-500' : ''}`}
    >
      <div className="flex items-center gap-4">
        <span className="text-gray-500 font-mono w-8">{position}</span>
        <span className={`text-lg ${isDone ? 'line-through text-gray-500' : 'text-white'}`}>
          {participant.name}
        </span>
        {isActive && (
          <span className="px-2 py-1 bg-orange-500 text-white text-xs font-bold rounded animate-pulse">
            NOW SINGING
          </span>
        )}
        {isSkipped && (
          <span className="px-2 py-1 bg-gray-600 text-gray-300 text-xs rounded">
            NOT PRESENT
          </span>
        )}
        {duration && (
          <span className="text-gray-500 text-sm">({duration})</span>
        )}
      </div>

      {showControls && !isDone && (
        <div className="flex gap-2">
          {!isActive && (
            <button
              onClick={() => onStatusChange?.(participant.id, 'active')}
              className="px-3 py-1 bg-orange-500 text-white text-sm rounded hover:bg-orange-600 transition-colors"
            >
              Start
            </button>
          )}
          <button
            onClick={() => onStatusChange?.(participant.id, 'complete')}
            className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
          >
            ✓ Done
          </button>
          <button
            onClick={() => onStatusChange?.(participant.id, 'skipped')}
            className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700 transition-colors"
          >
            ✗ Skip
          </button>
        </div>
      )}
    </div>
  );
}
