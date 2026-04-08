import React from 'react';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  avatar?: string | null;
  displayName?: string;
  size?: AvatarSize;
  className?: string;
}

const sizeMap: Record<AvatarSize, string> = {
  sm: 'w-8 h-8 text-base',
  md: 'w-12 h-12 text-xl',
  lg: 'w-24 h-24 text-4xl',
  xl: 'w-32 h-32 text-5xl',
};

/**
 * Avatar component - displays user avatar (image, emoji, or placeholder)
 * Handles: image URL, emoji, or default placeholder
 * Circular with amber border for images
 * Gradient background for emoji/placeholder
 */
export function Avatar({ avatar, displayName, size = 'md', className = '' }: AvatarProps) {
  const sizeClasses = sizeMap[size];

  // Check if avatar is an image URL (including blob: for previews)
  const isImageUrl = avatar && (avatar.startsWith('http') || avatar.startsWith('/') || avatar.startsWith('blob:'));

  if (isImageUrl) {
    return (
      <div className={`${sizeClasses} rounded-full border-2 border-[#F59E0B] overflow-hidden bg-black ${className}`}>
        <img
          src={avatar}
          alt={displayName || 'Avatar'}
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  // Emoji or placeholder
  const displayContent = avatar || '👤';

  return (
    <div
      className={`${sizeClasses} rounded-full flex items-center justify-center bg-gradient-to-br from-[#F59E0B]/20 to-[#D97706]/20 border border-[#F59E0B]/30 ${className}`}
    >
      <span className="select-none">{displayContent}</span>
    </div>
  );
}
