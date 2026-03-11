'use client';

import { getSocialPlatform, SocialIcon } from './social-icons';

interface Link {
  id: string;
  title: string;
  url: string;
  icon?: string | null;
  thumbnail?: string | null;
}

interface LinkButtonProps {
  link: Link;
  buttonColor: string;
  buttonTextColor: string;
  borderRadius: string;
}

export default function LinkButton({
  link,
  buttonColor,
  buttonTextColor,
  borderRadius
}: LinkButtonProps) {

  const handleClick = async () => {
    // Record click (fire and forget)
    fetch(`/api/links/${link.id}/click`, { method: 'POST' }).catch(() => {});
  };

  const socialPlatform = getSocialPlatform(link.url);
  const showIcon = link.icon || socialPlatform || link.thumbnail;

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="block w-full py-4 px-6 text-center font-semibold transition-all hover:scale-[1.02] hover:shadow-lg"
      style={{
        backgroundColor: buttonColor,
        color: buttonTextColor,
        borderRadius,
      }}
    >
      <span className="flex items-center justify-center gap-2">
        {showIcon && (
          <>
            {link.thumbnail && (
              <img
                src={link.thumbnail}
                alt=""
                className="w-6 h-6 rounded object-cover"
              />
            )}
            {!link.thumbnail && link.icon && <span>{link.icon}</span>}
            {!link.thumbnail && !link.icon && socialPlatform && (
              <SocialIcon platform={socialPlatform} className="w-5 h-5" />
            )}
          </>
        )}
        <span>{link.title}</span>
      </span>
    </a>
  );
}
