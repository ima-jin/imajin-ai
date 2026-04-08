import path from 'path';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/mnt/media';

/**
 * Get the assets directory for a given DID.
 * Path: /mnt/media/{did}/assets/
 */
export function assetsDir(did: string): string {
  return path.join(MEDIA_ROOT, did, 'assets');
}

/**
 * Get the thumbnails directory for a given DID.
 * Path: /mnt/media/{did}/thumbs/
 */
export function thumbsDir(did: string): string {
  return path.join(MEDIA_ROOT, did, 'thumbs');
}

/**
 * Get the full storage path for an asset file.
 */
export function assetPath(did: string, filename: string): string {
  return path.join(assetsDir(did), filename);
}

/**
 * Get the full storage path for a thumbnail file.
 */
export function thumbPath(did: string, filename: string): string {
  return path.join(thumbsDir(did), filename);
}
