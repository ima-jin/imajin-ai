import React from 'react';
import { AssetCard, AssetCardProps } from './AssetCard';

export interface MediaBrowserProps {
  assets: AssetCardProps[];
  onSelect?: (id: string) => void;
  loading?: boolean;
  emptyMessage?: string;
}

export function MediaBrowser({
  assets,
  onSelect,
  loading = false,
  emptyMessage = 'No media yet.',
}: MediaBrowserProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        Loading...
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
      {assets.map(asset => (
        <AssetCard key={asset.id} {...asset} onClick={onSelect} />
      ))}
    </div>
  );
}
