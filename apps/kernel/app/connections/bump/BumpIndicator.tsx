'use client';

interface Props {
  timeRemaining: number; // seconds
  onPress?: () => void;
}

export default function BumpIndicator({ timeRemaining, onPress }: Props) {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = String(timeRemaining % 60).padStart(2, '0');

  return (
    <button
      onClick={onPress}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full transition hover:opacity-80"
      style={{
        backgroundColor: 'rgba(249,115,22,0.15)',
        border: '1px solid rgba(249,115,22,0.3)',
      }}
      title="Bump Connect active"
    >
      <span
        className="w-2 h-2 rounded-full bg-orange-500 shrink-0"
        style={{ animation: 'bump-breathe 1.5s ease-in-out infinite' }}
      />
      <span className="text-orange-400 text-xs font-medium whitespace-nowrap">
        Bumping · {minutes}:{seconds}
      </span>

      <style>{`
        @keyframes bump-breathe {
          0%, 100% { opacity: 0.3; transform: scale(0.95); }
          50%       { opacity: 0.6; transform: scale(1.05); }
        }
      `}</style>
    </button>
  );
}
