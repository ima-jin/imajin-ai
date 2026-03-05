'use client';

interface LocationMessageProps {
  lat: number;
  lng: number;
  label?: string;
  accuracy?: number;
  isOwn: boolean;
}

export function LocationMessage({ lat, lng, label, isOwn }: LocationMessageProps) {
  const mapsUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15`;
  const displayLabel = label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  const zoom = 15;
  const tileX = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const latRad = (lat * Math.PI) / 180;
  const tileY = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
  const tileUrl = `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;

  const containerBg = isOwn ? 'bg-white/10' : 'bg-gray-100 dark:bg-gray-700';
  const labelColor = isOwn ? 'text-white' : 'text-gray-800 dark:text-gray-200';
  const subColor = isOwn ? 'text-white/60' : 'text-gray-500 dark:text-gray-400';

  return (
    <a
      href={mapsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`block max-w-[240px] rounded-xl overflow-hidden transition hover:opacity-90 ${containerBg}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative h-[100px] overflow-hidden bg-gray-200 dark:bg-gray-600">
        <img
          src={tileUrl}
          alt="Map"
          className="w-full h-full object-cover"
          loading="lazy"
        />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-5 h-5 bg-orange-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
            <div className="w-1.5 h-1.5 bg-white rounded-full" />
          </div>
        </div>
      </div>

      <div className="px-3 py-2 flex items-center gap-2">
        <svg className="w-4 h-4 flex-shrink-0 text-orange-500" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium truncate ${labelColor}`}>{displayLabel}</p>
          <p className={`text-xs ${subColor}`}>Tap to open in maps</p>
        </div>
      </div>
    </a>
  );
}
