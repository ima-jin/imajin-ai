interface BusinessDetailsProps {
  metadata?: Record<string, unknown>;
}

export function BusinessDetails({ metadata }: BusinessDetailsProps) {
  if (!metadata) return null;

  const location = metadata.location as string | undefined;
  const phone = metadata.phone as string | undefined;
  const website = metadata.website as string | undefined;
  const category = metadata.category as string | undefined;

  if (!location && !phone && !website && !category) return null;

  return (
    <div className="mb-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4 text-left">
      <p className="text-xs text-gray-500 mb-2 text-center">🏢 Business Info</p>
      {category && (
        <p className="text-sm text-gray-300 mb-1">
          <span className="text-gray-500">🏷️</span>{' '}
          <span>{category}</span>
        </p>
      )}
      {location && (
        <p className="text-sm text-gray-300 mb-1">
          <span className="text-gray-500">📍</span>{' '}
          <span>{location}</span>
        </p>
      )}
      {phone && (
        <p className="text-sm text-gray-300 mb-1">
          <span className="text-gray-500">📞</span>{' '}
          <a href={`tel:${phone}`} className="text-[#F59E0B] hover:underline">
            {phone}
          </a>
        </p>
      )}
      {website && (
        <p className="text-sm text-gray-300">
          <span className="text-gray-500">🌐</span>{' '}
          <a
            href={website.startsWith('http') ? website : `https://${website}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#F59E0B] hover:underline"
          >
            {website}
          </a>
        </p>
      )}
    </div>
  );
}
