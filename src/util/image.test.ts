import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { describeImageChange, downscale, encodeImageFile, imageNote, normalizeImage, normalizeImageData } from "./image.js";
import { buildAttachmentMessage } from "./attachments.js";

/** A photo-like PNG (noisy gradients): compresses badly as PNG, well as JPEG. */
function photoPng(width: number, height: number, alpha = 255): Buffer {
  const png = new PNG({ width, height });
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 32);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 255) / width + rand();
      png.data[i + 1] = (y * 255) / height + rand();
      png.data[i + 2] = ((x + y) * 128) / (width + height) + rand();
      png.data[i + 3] = alpha;
    }
  }
  return PNG.sync.write(png);
}

/** A flat UI-like PNG (few colours, big blocks): PNG beats JPEG. */
function flatPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = (Math.floor(x / 200) + Math.floor(y / 120)) % 2 ? 255 : 30;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("normalizeImage", () => {
  it("downscales a large photo-like screenshot to the long-edge limit and picks JPEG", () => {
    const src = photoPng(3024, 1900);
    const out = normalizeImage(src, "image/png");
    assert.strictEqual(out.mime, "image/jpeg");
    assert.deepStrictEqual([out.change?.width, out.change?.height], [1568, 985]);
    assert.ok(out.data.byteLength < src.byteLength / 3, `${out.data.byteLength} vs ${src.byteLength}`);
    const decoded = jpeg.decode(out.data);
    assert.deepStrictEqual([decoded.width, decoded.height], [1568, 985]);
  });

  it("keeps PNG when it's smaller (flat UI), and for transparent images", () => {
    const flat = normalizeImage(flatPng(3000, 2000), "image/png");
    assert.strictEqual(flat.mime, "image/png");
    assert.strictEqual(flat.change?.format, "png");
    const transparent = normalizeImage(photoPng(2000, 1000, 128), "image/png");
    assert.strictEqual(transparent.mime, "image/png");
    assert.strictEqual(PNG.sync.read(transparent.data).data[3], 128, "alpha survives");
  });

  it("never upscales; small images and undecodable formats pass through unchanged", () => {
    const small = photoPng(400, 300);
    const out = normalizeImage(small, "image/png");
    assert.strictEqual(out.change, null);
    assert.strictEqual(out.data, small);
    const gif = Buffer.from("GIF89a-not-really");
    assert.strictEqual(normalizeImage(gif, "image/gif").data, gif);
    assert.strictEqual(normalizeImage(Buffer.from("broken"), "image/png").change, null);
  });

  it("maxEdge 0 disables normalization; a custom edge is honoured", () => {
    const src = photoPng(2000, 1000);
    assert.strictEqual(normalizeImage(src, "image/png", { maxEdge: 0 }).data, src);
    assert.deepStrictEqual(normalizeImage(src, "image/png", { maxEdge: 1024 }).change?.width, 1024);
  });

  it("re-encodes an oversized JPEG within the limit only if that makes it smaller", () => {
    const big = Buffer.from(jpeg.encode({ width: 1200, height: 800, data: PNG.sync.read(photoPng(1200, 800)).data }, 100).data);
    const out = normalizeImage(big, "image/jpeg");
    assert.ok(out.change === null || out.data.byteLength < big.byteLength);
  });
});

describe("downscale", () => {
  it("averages the covered source pixels", () => {
    const src = { width: 2, height: 2, data: Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]) };
    const out = downscale(src, 1, 1);
    assert.deepStrictEqual([...out.data], [128, 128, 128, 255]);
  });
});

describe("attach paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "img-norm-"));
  const shot = join(dir, "shot.png");
  writeFileSync(shot, photoPng(3024, 1900));

  it("encodeImageFile normalizes and reports the change; the original stays on disk", async () => {
    const img = await encodeImageFile(shot);
    assert.match(img.dataUrl, /^data:image\/jpeg;base64,/);
    assert.ok(img.change);
    assert.match(describeImageChange(img.filename, img.change!), /^image shot\.png: \d+ KB → \d+ KB \(1568×985 jpeg\)$/);
    assert.match(imageNote(shot, img.change!), /downscaled to 1568×985 .* original is at .*shot\.png/);
  });

  it("print/server attachments carry the image, a note for the model, and a notice", async () => {
    const msg = await buildAttachmentMessage("what is this?", [shot], dir);
    assert.ok(Array.isArray(msg.content));
    const parts = msg.content as Array<{ type: string; text?: string }>;
    assert.match(parts[0]!.text!, /^what is this\?\n\n\[Attached image shot\.png was downscaled/);
    assert.strictEqual(parts[1]!.type, "image_url");
    assert.strictEqual(msg.notices.length, 1);
  });

  it("SDK inline data is normalized too, and left alone when already small", () => {
    const big = normalizeImageData(photoPng(3024, 1900).toString("base64"), "image/png");
    assert.strictEqual(big.mime, "image/jpeg");
    const tiny = photoPng(10, 10).toString("base64");
    assert.strictEqual(normalizeImageData(tiny, "image/png").base64, tiny);
  });
});
