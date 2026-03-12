import React from 'react';

interface LinkPreviewCardProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

export function LinkPreviewCard({
  url,
  title,
  description,
  image,
  favicon,
  siteName,
}: LinkPreviewCardProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block mt-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 overflow-hidden transition-colors no-underline bg-white dark:bg-gray-900"
    >
      {/* OG image — stacked on top for proper rendering */}
      {image && (
        <div className="w-full max-h-40 overflow-hidden">
          <img
            src={image}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              e.currentTarget.parentElement!.style.display = 'none';
            }}
          />
        </div>
      )}

      {/* Content */}
      <div className="p-3">
        {/* Site name and favicon */}
        {(siteName || favicon) && (
          <div className="flex items-center gap-1.5 mb-1.5 text-xs text-gray-500 dark:text-gray-400">
            {favicon && (
              <img
                src={favicon}
                alt=""
                className="w-4 h-4 rounded"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            )}
            {siteName && <span className="truncate">{siteName}</span>}
          </div>
        )}

        {/* Title */}
        {title && (
          <div className="font-medium text-sm text-gray-900 dark:text-gray-100 line-clamp-2 mb-1">
            {title}
          </div>
        )}

        {/* Description */}
        {description && (
          <div className="text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
            {description}
          </div>
        )}

        {/* URL fallback if no title */}
        {!title && !description && (
          <div className="text-xs text-gray-600 dark:text-gray-300 truncate">
            {url}
          </div>
        )}
      </div>
    </a>
  );
}
