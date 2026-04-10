'use client';

interface ProfileCardProps {
  handle?: string;
  name?: string;
  avatar?: string;
  /** Optional note below the name, e.g. "Connected since Apr 4, 2026" */
  note?: string;
  /** Optional label above the card, e.g. "Already connected" */
  label?: string;
  /** Label color class */
  labelColor?: string;
}

function getInitial(name?: string, handle?: string): string {
  return (name || handle || '?')[0].toUpperCase();
}

export default function ProfileCard({
  handle,
  name,
  avatar,
  note,
  label,
  labelColor = 'text-gray-400',
}: ProfileCardProps) {
  const isImageUrl = avatar && (avatar.startsWith('http') || avatar.startsWith('/') || avatar.startsWith('blob:'));

  return (
    <div className="flex flex-col items-center text-center">
      {label && (
        <p className={`text-sm mb-3 ${labelColor}`}>{label}</p>
      )}

      {/* Avatar */}
      {isImageUrl ? (
        <div className="w-20 h-20 rounded-full border-2 border-orange-500 overflow-hidden bg-black mb-4">
          <img src={avatar} alt={name || handle || 'Avatar'} className="w-full h-full object-cover" />
        </div>
      ) : (
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center text-3xl font-bold text-black mb-4"
          style={{ backgroundColor: '#f97316' }}
        >
          {avatar || getInitial(name, handle)}
        </div>
      )}

      {/* Handle */}
      {handle && (
        <p className="text-orange-400 text-xl font-semibold">@{handle}</p>
      )}

      {/* Name */}
      {name && name !== handle && (
        <p className="text-white text-lg mt-1">{name}</p>
      )}

      {/* Note */}
      {note && (
        <p className="text-gray-500 text-sm mt-2">{note}</p>
      )}
    </div>
  );
}
