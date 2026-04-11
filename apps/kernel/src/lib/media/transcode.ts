import { spawn } from 'child_process';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export const VIDEO_QUALITIES = ['1080p', '720p', '360p'] as const;
export type VideoQuality = typeof VIDEO_QUALITIES[number];

const QUALITY_CONFIG: Record<VideoQuality, { width: number; height: number; crf: number; audioBitrate: string }> = {
  '1080p': { width: 1920, height: 1080, crf: 23, audioBitrate: '128k' },
  '720p': { width: 1280, height: 720, crf: 25, audioBitrate: '128k' },
  '360p': { width: 640, height: 360, crf: 28, audioBitrate: '96k' },
};

// Track active transcodes to prevent duplicates
const activeTranscodes = new Set<string>();
const MAX_CONCURRENT = 2;
const transcodeQueue: Array<() => void> = [];

export function getVariantPath(originalPath: string, quality: VideoQuality): string {
  return `${originalPath}.${quality}.mp4`;
}

export async function variantExists(originalPath: string, quality: VideoQuality): Promise<boolean> {
  try {
    await access(getVariantPath(originalPath, quality), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function isTranscoding(originalPath: string, quality: VideoQuality): boolean {
  return activeTranscodes.has(`${originalPath}:${quality}`);
}

export async function getAvailableVariants(originalPath: string): Promise<Record<VideoQuality, boolean>> {
  const result = {} as Record<VideoQuality, boolean>;
  for (const q of VIDEO_QUALITIES) {
    result[q] = await variantExists(originalPath, q);
  }
  return result;
}

export function getTranscodingStatus(originalPath: string): Record<VideoQuality, boolean> {
  const result = {} as Record<VideoQuality, boolean>;
  for (const q of VIDEO_QUALITIES) {
    result[q] = isTranscoding(originalPath, q);
  }
  return result;
}

function runNext() {
  if (activeTranscodes.size < MAX_CONCURRENT && transcodeQueue.length > 0) {
    const next = transcodeQueue.shift();
    next?.();
  }
}

export function transcodeVideo(originalPath: string, quality: VideoQuality): Promise<string> {
  const key = `${originalPath}:${quality}`;
  const outPath = getVariantPath(originalPath, quality);

  if (activeTranscodes.has(key)) {
    return Promise.reject(new Error('Already transcoding'));
  }

  return new Promise((resolve, reject) => {
    const start = () => {
      activeTranscodes.add(key);
      const config = QUALITY_CONFIG[quality];
      const args = [
        '-i', originalPath,
        '-vf', `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease,pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`,
        '-c:v', 'libx264',
        '-crf', String(config.crf),
        '-preset', 'slow',
        '-c:a', 'aac',
        '-b:a', config.audioBitrate,
        '-movflags', '+faststart',
        '-y',
        outPath,
      ];

      log.info({ quality, originalPath }, 'starting transcode');
      const proc = spawn('ffmpeg', args);

      proc.stderr.on('data', (_data) => {
        // ffmpeg outputs progress to stderr — just log last line occasionally
      });

      proc.on('close', (code) => {
        activeTranscodes.delete(key);
        runNext();
        if (code === 0) {
          log.info({ quality, outPath }, 'transcode completed');
          resolve(outPath);
        } else {
          log.error({ quality, code }, 'transcode failed');
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        activeTranscodes.delete(key);
        runNext();
        reject(err);
      });
    };

    if (activeTranscodes.size >= MAX_CONCURRENT) {
      transcodeQueue.push(start);
    } else {
      start();
    }
  });
}
