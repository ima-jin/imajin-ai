'use client';

interface Link {
  id: string;
  title: string;
  url: string;
  icon?: string;
  thumbnail?: string;
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
        {link.icon && <span>{link.icon}</span>}
        {link.thumbnail && (
          <img 
            src={link.thumbnail} 
            alt="" 
            className="w-6 h-6 rounded object-cover"
          />
        )}
        <span>{link.title}</span>
      </span>
    </a>
  );
}
