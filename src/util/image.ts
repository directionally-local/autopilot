import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * Images are normalized once, when attached: chat requests are stateless, so
 * an image is re-uploaded with every call for as long as it stays in context.
 * Providers downscale large images internally anyway, so pixels past
 * ~1568px on the long edge mostly cost upload time (#823).
 */
export interface ImageNormalizeOptions {
  /** Longest edge in pixels; never upscales. 0 disables normalization. */
  maxEdge?: number;
  /** JPEG quality, 1–100. */
  quality?: number;
}

export const DEFAULT_IMAGE_MAX_EDGE = 1568;
export const DEFAULT_IMAGE_QUALITY = 75;
/** Already within the edge limit and this small: sent as-is. */
const PASS_THROUGH_BYTES = 256 * 1024;

export interface NormalizedImage {
  data: Buffer;
  mime: string;
  /** What was done, for the user-facing note; null when sent unchanged. */
  change: { fromBytes: number; toBytes: number; width: number; height: number; format: "jpeg" | "png" } | null;
}

interface Rgba {
  width: number;
  height: number;
  data: Buffer | Uint8Array;
}

function decode(buf: Buffer, mime: string): Rgba | null {
  try {
    if (mime === "image/png") return PNG.sync.read(buf);
    if (mime === "image/jpeg") return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  } catch {
    // undecodable: send as-is
  }
  return null;
}

/** Box-filter downscale: each target pixel averages the source pixels it covers. */
export function downscale(src: Rgba, width: number, height: number): Rgba {
  if (width === src.width && height === src.height) return src;
  const out = Buffer.alloc(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          a += src.data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

function hasTransparency(img: Rgba): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 255) return true;
  return false;
}

/**
 * Downscale to `maxEdge` and re-encode as JPEG or PNG, whichever is smaller
 * (flat UI screenshots can stay PNG). Transparent images stay PNG. Formats we
 * can't decode (GIF, WebP, BMP) and small images pass through unchanged, as
 * does anything the re-encode wouldn't shrink.
 */
export function normalizeImage(buf: Buffer, mime: string, opts: ImageNormalizeOptions = {}): NormalizedImage {
  const maxEdge = opts.maxEdge ?? DEFAULT_IMAGE_MAX_EDGE;
  const unchanged: NormalizedImage = { data: buf, mime, change: null };
  if (maxEdge <= 0) return unchanged;
  const src = decode(buf, mime);
  if (!src) return unchanged;
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (scale === 1 && buf.byteLength <= PASS_THROUGH_BYTES) return unchanged;

  const img = downscale(src, Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale)));
  const candidates: Array<{ data: Buffer; mime: string; format: "jpeg" | "png" }> = [];
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  candidates.push({ data: PNG.sync.write(png, { colorType: hasTransparency(img) ? 6 : 2 }), mime: "image/png", format: "png" });
  if (!hasTransparency(img)) {
    const quality = Math.min(100, Math.max(1, opts.quality ?? DEFAULT_IMAGE_QUALITY));
    candidates.push({ data: jpeg.encode({ ...img, data: Buffer.from(img.data) }, quality).data, mime: "image/jpeg", format: "jpeg" });
  }
  const best = candidates.reduce((a, b) => (b.data.byteLength < a.data.byteLength ? b : a));
  // Same size but bigger file (e.g. an already-tight JPEG): keep the original.
  if (scale === 1 && best.data.byteLength >= buf.byteLength) return unchanged;
  return {
    data: best.data,
    mime: best.mime,
    change: { fromBytes: buf.byteLength, toBytes: best.data.byteLength, width: img.width, height: img.height, format: best.format },
  };
}

export interface EncodedImage {
  filename: string;
  mime: string;
  dataUrl: string;
  /** Set when the image was downscaled/re-encoded; the original stays on disk at `path`. */
  change?: NormalizedImage["change"];
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** One line for the user, e.g. `image shot.png: 595 KB → 112 KB (1568×985 jpeg)`. */
export function describeImageChange(filename: string, change: NonNullable<NormalizedImage["change"]>): string {
  return `image ${filename}: ${kb(change.fromBytes)} → ${kb(change.toBytes)} (${change.width}×${change.height} ${change.format})`;
}

/** Tells the model the image was reduced and where the full-resolution original is. */
export function imageNote(path: string, change: NonNullable<NormalizedImage["change"]>): string {
  return `[Attached image ${basename(path)} was downscaled to ${change.width}×${change.height} for upload; the full-resolution original is at ${path}]`;
}

export async function encodeImageFile(filePath: string, opts: ImageNormalizeOptions = {}): Promise<EncodedImage> {
  const buf = await readFile(filePath);
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB); max is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
    );
  }
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const out = normalizeImage(buf, EXT_TO_MIME[ext] ?? "image/jpeg", opts);
  return {
    filename: basename(filePath),
    mime: out.mime,
    dataUrl: `data:${out.mime};base64,${out.data.toString("base64")}`,
    ...(out.change ? { change: out.change } : {}),
  };
}

/** Normalize inline base64 image data (SDK callers that pass bytes instead of a path). */
export function normalizeImageData(base64: string, mime: string, opts: ImageNormalizeOptions = {}): { mime: string; base64: string; change: NormalizedImage["change"] } {
  const out = normalizeImage(Buffer.from(base64, "base64"), mime, opts);
  return { mime: out.mime, base64: out.change ? out.data.toString("base64") : base64, change: out.change };
}

export function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ext in EXT_TO_MIME;
}

export function imageMimeOf(path: string): string {
  return EXT_TO_MIME[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "image/jpeg";
}
