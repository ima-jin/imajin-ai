import { extractExif } from "./exif";

export interface ClassifyResult {
  category: string;       // photo, document, audio, video, screenshot, receipt, other
  subcategory?: string;
  tags: string[];
  suggestedName?: string;
  suggestedFolder: string; // Photos, Audio, Videos, Documents, Uncategorized
  confidence: number;      // 0-1
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

export async function classifyAsset(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ClassifyResult> {
  // ── Video ──────────────────────────────────────────────────────────────────
  if (mimeType.startsWith("video/")) {
    return {
      category: "video",
      tags: ["video"],
      suggestedFolder: "Videos",
      confidence: 0.5, // pure mime-type fallback
    };
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  if (mimeType.startsWith("audio/")) {
    const isVoiceMemo = nameContains(filename, "voice", "memo", "recording", "rec_", "audio_note");
    return {
      category: "audio",
      subcategory: isVoiceMemo ? "voice_memo" : "music",
      tags: isVoiceMemo ? ["audio", "voice-memo"] : ["audio", "music"],
      suggestedFolder: "Audio",
      confidence: isVoiceMemo ? 0.7 : 0.5, // filename match vs pure mime
    };
  }

  // ── Documents ─────────────────────────────────────────────────────────────
  const isFilenameDoc = nameContains(filename, ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods");
  const isMimeDoc =
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("word") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("presentation") ||
    mimeType.includes("opendocument");

  if (isMimeDoc || isFilenameDoc) {
    const isReceipt = nameContains(filename, "receipt", "invoice", "bill");
    if (isReceipt) {
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

  // ── Images ─────────────────────────────────────────────────────────────────
  if (mimeType.startsWith("image/")) {
    // Receipt heuristic: filename keywords
    if (nameContains(filename, "receipt", "invoice", "bill")) {
      return {
        category: "receipt",
        tags: ["photo", "receipt"],
        suggestedFolder: "Documents",
        confidence: 0.7, // filename keyword match
      };
    }

    // Screenshot heuristic: filename keywords
    if (nameContains(filename, "screenshot", "screen_shot", "screen-shot", "scr_", "capture")) {
      return {
        category: "screenshot",
        tags: ["photo", "screenshot"],
        suggestedFolder: "Photos",
        confidence: 0.7, // filename keyword match
      };
    }

    // EXIF-based checks
    try {
      const exif = await extractExif(buffer);

      // Camera make/model present → high confidence real photo
      if (exif?.camera) {
        return {
          category: "photo",
          tags: ["photo"],
          suggestedFolder: "Photos",
          confidence: 0.9, // EXIF camera data
        };
      }

      if (exif?.width && exif?.height) {
        const key = `${exif.width}x${exif.height}`;
        const keyAlt = `${exif.height}x${exif.width}`;
        if (SCREENSHOT_DIMENSIONS.has(key) || SCREENSHOT_DIMENSIONS.has(keyAlt)) {
          return {
            category: "screenshot",
            tags: ["photo", "screenshot"],
            suggestedFolder: "Photos",
            confidence: 0.5, // dimension-only heuristic
          };
        }

        // Receipt heuristic: very tall aspect ratio (height > 2× width)
        const ratio = exif.height / exif.width;
        if (ratio > 2.5) {
          return {
            category: "receipt",
            tags: ["photo", "receipt"],
            suggestedFolder: "Documents",
            confidence: 0.5, // dimension-only heuristic
          };
        }
      }
    } catch {
      // EXIF extraction failure is non-fatal
    }

    return {
      category: "photo",
      tags: ["photo"],
      suggestedFolder: "Photos",
      confidence: 0.5, // pure mime-type fallback
    };
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return {
    category: "other",
    tags: [],
    suggestedFolder: "Uncategorized",
    confidence: 0.3,
  };
}
