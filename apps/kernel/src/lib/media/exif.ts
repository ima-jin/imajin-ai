export interface ExifData {
  dateTaken?: Date;
  camera?: string;
  gps?: { lat: number; lng: number };
  width?: number;
  height?: number;
}

export async function extractExif(buffer: Buffer): Promise<ExifData | null> {
  try {
    const exifReader = (await import("exif-reader")).default;

    // exif-reader expects the raw EXIF segment; for JPEG we need to locate it
    const result = exifReader(buffer);
    if (!result) return null;

    const out: ExifData = {};

    // Date taken (prefer DateTimeOriginal, fall back to DateTime)
    const dateStr =
      result.Photo?.DateTimeOriginal ??
      result.Photo?.DateTimeDigitized ??
      result.Image?.DateTime;
    if (dateStr) {
      // EXIF date format: "YYYY:MM:DD HH:MM:SS"
      const normalized = String(dateStr).replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) out.dateTaken = d;
    }

    // Camera model
    const make = result.Image?.Make;
    const model = result.Image?.Model;
    if (make || model) {
      out.camera = [make, model].filter(Boolean).join(" ").trim();
    }

    // GPS coordinates
    const gps = result.GPSInfo;
    if (gps?.GPSLatitude && gps?.GPSLongitude) {
      const toLat = (dms: number[], ref: string) => {
        const deg = dms[0] + dms[1] / 60 + dms[2] / 3600;
        return ref === "S" ? -deg : deg;
      };
      const toLng = (dms: number[], ref: string) => {
        const deg = dms[0] + dms[1] / 60 + dms[2] / 3600;
        return ref === "W" ? -deg : deg;
      };
      out.gps = {
        lat: toLat(gps.GPSLatitude as number[], String(gps.GPSLatitudeRef ?? "N")),
        lng: toLng(gps.GPSLongitude as number[], String(gps.GPSLongitudeRef ?? "E")),
      };
    }

    // Pixel dimensions
    const w =
      result.Photo?.PixelXDimension ??
      result.Image?.ImageWidth;
    const h =
      result.Photo?.PixelYDimension ??
      result.Image?.ImageLength;
    if (w) out.width = Number(w);
    if (h) out.height = Number(h);

    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
