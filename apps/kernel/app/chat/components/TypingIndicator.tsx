'use client';

interface TypingIndicatorProps {
  typingUsers: Array<{ did: string; name: string | null }>;
}

export function TypingIndicator({ typingUsers }: TypingIndicatorProps) {
  if (typingUsers.length === 0) return null;

  const displayText = () => {
    if (typingUsers.length === 1) {
      const name = typingUsers[0].name || 'Someone';
      return `${name} is typing`;
    } else if (typingUsers.length === 2) {
      const name1 = typingUsers[0].name || 'Someone';
      const name2 = typingUsers[1].name || 'someone';
      return `${name1} and ${name2} are typing`;
    } else {
      const name1 = typingUsers[0].name || 'Someone';
      const others = typingUsers.length - 1;
      return `${name1} and ${others} ${others === 1 ? 'other' : 'others'} are typing`;
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm text-gray-500 px-4 py-2">
      <span>{displayText()}</span>
      <span className="flex gap-1">
        <span className="animate-bounce inline-block" style={{ animationDelay: '0ms' }}>.</span>
        <span className="animate-bounce inline-block" style={{ animationDelay: '150ms' }}>.</span>
        <span className="animate-bounce inline-block" style={{ animationDelay: '300ms' }}>.</span>
      </span>
    </div>
  );
}
