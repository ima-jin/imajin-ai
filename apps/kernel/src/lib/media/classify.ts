import { extractExif } from "./exif";
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface ClassifyResult {
  category: string;       // photo, document, audio, video, screenshot, receipt, other
  subcategory?: string;
  tags: string[];
  suggestedName?: string;
  suggestedFolder: string; // Photos, Audio, Videos, Documents, Uncategorized
  confidence: number;      // 0-1
}

// ── CLIP integration ─────────────────────────────────────────────────────────

const CLIP_URL = process.env.CLIP_URL;
const CLIP_TIMEOUT_MS = 5000;

interface ClipResult {
  label: string;
  confidence: number;
  tags: string[];
}

// Map CLIP labels to our category system
const CLIP_LABEL_MAP: Record<string, { category: string; folder: string }> = {
  'photograph': { category: 'photo', folder: 'Photos' },
  'screenshot': { category: 'screenshot', folder: 'Photos' },
  'document': { category: 'document', folder: 'Documents' },
  'receipt': { category: 'receipt', folder: 'Documents' },
  'artwork': { category: 'photo', folder: 'Photos' },
  'illustration': { category: 'photo', folder: 'Photos' },
  'meme': { category: 'photo', folder: 'Photos' },
  'diagram': { category: 'document', folder: 'Documents' },
  'logo': { category: 'photo', folder: 'Photos' },
  'map': { category: 'document', folder: 'Documents' },
  'icon': { category: 'photo', folder: 'Photos' },
  'text': { category: 'document', folder: 'Documents' },
  'ui-element': { category: 'screenshot', folder: 'Photos' },
  'other': { category: 'other', folder: 'Uncategorized' },
};

async function classifyWithClip(buffer: Buffer, callerDid?: string): Promise<ClipResult | null> {
  if (!CLIP_URL) return null;
  try {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(buffer)]), 'image.bin');

    const headers: Record<string, string> = {};
    if (callerDid) headers['X-Caller-DID'] = callerDid;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLIP_TIMEOUT_MS);

    const res = await fetch(`${CLIP_URL}/classify`, {
      method: 'POST',
      body: formData,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    return { label: data.label, confidence: data.confidence, tags: data.tags };
  } catch (err) {
    // CLIP unavailable — fall through to heuristics silently
    log.warn({ err: (err as Error).message }, 'CLIP unavailable');
    return null;
  }
}

// Common phone screenshot resolutions (width x height, portrait)
const SCREENSHOT_DIMENSIONS = new Set([
  "390x844",  // iPhone 12/13/14
  "393x852",  // iPhone 15
  "414x896",  // iPhone XR/11
  "375x812",  // iPhone X/XS
  "360x800",  // Android common
  "412x915",  // Pixel 6
  "1080x1920",
  "1170x2532",
  "1179x2556",
  "1284x2778",
  "1080x2340",
  "1080x2400",
]);

function nameContains(filename: string, ...terms: string[]): boolean {
  const lower = filename.toLowerCase();
  return terms.some((t) => lower.includes(t));
}

function classifyVideo(): ClassifyResult {
  return {
    category: "video",
    tags: ["video"],
    suggestedFolder: "Videos",
    confidence: 0.5, // pure mime-type fallback
  };
}

function classifyAudio(filename: string): ClassifyResult {
  const isVoiceMemo = nameContains(filename, "voice", "memo", "recording", "rec_", "audio_note");
  return {
    category: "audio",
    subcategory: isVoiceMemo ? "voice_memo" : "music",
    tags: isVoiceMemo ? ["audio", "voice-memo"] : ["audio", "music"],
    suggestedFolder: "Audio",
    confidence: isVoiceMemo ? 0.7 : 0.5, // filename match vs pure mime
  };
}

// Returns null when the file doesn't look like a document at all.
function classifyDocument(filename: string, mimeType: string): ClassifyResult | null {
  const isFilenameDoc = nameContains(filename, ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods");
  const isMimeDoc =
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("word") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("presentation") ||
    mimeType.includes("opendocument");

  if (!isMimeDoc && !isFilenameDoc) return null;

  if (nameContains(filename, "receipt", "invoice", "bill")) {
    return {
      category: "receipt",
      tags: ["document", "receipt"],
      suggestedFolder: "Documents",
      confidence: 0.7, // filename keyword match
    };
  }
  return {
    category: "document",
    tags: ["document"],
    suggestedFolder: "Documents",
    confidence: isFilenameDoc ? 0.7 : 0.5, // filename match vs pure mime
  };
}

// High-confidence filename heuristics for images (skip CLIP/EXIF if obvious).
function classifyImageByFilename(filename: string): ClassifyResult | null {
  if (nameContains(filename, "receipt", "invoice", "bill")) {
    return {
      category: "receipt",
      tags: ["photo", "receipt"],
      suggestedFolder: "Documents",
      confidence: 0.7,
    };
  }

  if (nameContains(filename, "screenshot", "screen_shot", "screen-shot", "scr_", "capture")) {
    return {
      category: "screenshot",
      tags: ["photo", "screenshot"],
      suggestedFolder: "Photos",
      confidence: 0.7,
    };
  }

  return null;
}

type ExifInfo = { camera?: string; width?: number; height?: number };

async function extractImageExif(buffer: Buffer): Promise<ExifInfo | null> {
  try {
    return await extractExif(buffer);
  } catch {
    // EXIF extraction failure is non-fatal
    return null;
  }
}

function classifyClipResult(clip: ClipResult): ClassifyResult {
  const mapped = CLIP_LABEL_MAP[clip.label] || { category: 'other', folder: 'Uncategorized' };
  const baseTags = mapped.category === 'photo' ? ['photo'] : [mapped.category];
  return {
    category: mapped.category,
    tags: [...baseTags, ...clip.tags],
    suggestedFolder: mapped.folder,
    confidence: clip.confidence,
  };
}

// CLIP unavailable — fall back to dimension heuristics. Returns null when
// dimensions are unavailable or don't match a known heuristic.
function classifyImageByDimensions(exifResult: ExifInfo | null): ClassifyResult | null {
  if (!exifResult?.width || !exifResult?.height) return null;

  const key = `${exifResult.width}x${exifResult.height}`;
  const keyAlt = `${exifResult.height}x${exifResult.width}`;
  if (SCREENSHOT_DIMENSIONS.has(key) || SCREENSHOT_DIMENSIONS.has(keyAlt)) {
    return {
      category: "screenshot",
      tags: ["photo", "screenshot"],
      suggestedFolder: "Photos",
      confidence: 0.5,
    };
  }

  const ratio = exifResult.height / exifResult.width;
  if (ratio > 2.5) {
    return {
      category: "receipt",
      tags: ["photo", "receipt"],
      suggestedFolder: "Documents",
      confidence: 0.5,
    };
  }

  return null;
}

async function classifyImage(buffer: Buffer, filename: string): Promise<ClassifyResult> {
  const filenameResult = classifyImageByFilename(filename);
  if (filenameResult) return filenameResult;

  // EXIF camera → high confidence photo, no CLIP needed
  const exifResult = await extractImageExif(buffer);
  if (exifResult?.camera) {
    return {
      category: "photo",
      tags: ["photo"],
      suggestedFolder: "Photos",
      confidence: 0.9,
    };
  }

  // Try CLIP for visual classification (GPU node)
  const clip = await classifyWithClip(buffer);
  if (clip) return classifyClipResult(clip);

  const dimensionResult = classifyImageByDimensions(exifResult);
  if (dimensionResult) return dimensionResult;

  return {
    category: "photo",
    tags: ["photo"],
    suggestedFolder: "Photos",
    confidence: 0.5,
  };
}

function classifyOther(): ClassifyResult {
  return {
    category: "other",
    tags: [],
    suggestedFolder: "Uncategorized",
    confidence: 0.3,
  };
}

export async function classifyAsset(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ClassifyResult> {
  if (mimeType.startsWith("video/")) return classifyVideo();
  if (mimeType.startsWith("audio/")) return classifyAudio(filename);

  const documentResult = classifyDocument(filename, mimeType);
  if (documentResult) return documentResult;

  if (mimeType.startsWith("image/")) return classifyImage(buffer, filename);

  return classifyOther();
}
