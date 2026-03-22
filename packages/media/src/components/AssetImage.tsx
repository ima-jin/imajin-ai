'use client';

import React from 'react';
import { resolveAssetUrl } from '../resolve';

export interface AssetImageProps {
  /** Asset ID from media service (e.g. "asset_xxx") */
  assetId?: string | null;
  /** Fallback: emoji string or legacy URL if assetId is null */
  fallback?: string | null;
  alt: string;
  className?: string;
  width?: number;
  height?: number;
}

/**
 * Renders a media asset by ID, falling back to a legacy URL or emoji.
 *
 * Usage:
 *   <AssetImage assetId={row.avatarAssetId} fallback={row.avatar} alt="Avatar" />
 *
 * If assetId is set, resolves it to a content URL via NEXT_PUBLIC_MEDIA_URL.
 * If only fallback is set and it looks like an image URL, renders it directly.
 * Otherwise renders nothing (caller should supply an emoji fallback separately).
 */
export function AssetImage({ assetId, fallback, alt, className, width, height }: AssetImageProps) {
  const isImageUrl = (v: string) =>
    v.startsWith('http') || v.startsWith('/') || v.startsWith('blob:');

  let src: string | null = null;

  if (assetId) {
    src = resolveAssetUrl(assetId);
  } else if (fallback && isImageUrl(fallback)) {
    src = fallback;
  }

  if (!src) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      width={width}
      height={height}
    />
  );
}
