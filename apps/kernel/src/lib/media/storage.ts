import path from 'node:path';
import { resolveInside } from './safe-path';

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
  return requireInside(assetsDir(did), filename);
}

/**
 * Get the full storage path for a thumbnail file.
 */
export function thumbPath(did: string, filename: string): string {
  return requireInside(thumbsDir(did), filename);
}

/** Join a filename onto a directory, refusing anything that would escape it (#2681). */
function requireInside(dir: string, filename: string): string {
  const resolved = resolveInside(dir, filename);
  if (!resolved) throw new Error('Unsafe filename');
  return resolved;
}
