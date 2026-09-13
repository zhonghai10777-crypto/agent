import { DEFAULT_VISION_ROUTING_SETTINGS, type VisionRoutingSettings } from "./vision-types.js";

/** Shared by the renderer preflight and both model routes. No decoding or I/O. */
export class ImageBudgetError extends Error {
  constructor(readonly code: "VISION_IMAGE_LIMIT" | "VISION_IMAGE_INVALID" | "VISION_ANIMATED_IMAGE" | "VISION_PAYLOAD", message: string) {
    super(`${code}: ${message}`);
    this.name = "ImageBudgetError";
  }
}

export function assertImageSizes(sizes: readonly number[], settings = DEFAULT_VISION_ROUTING_SETTINGS): void {
  if (sizes.length > settings.maxImagesPerMessage) throw new ImageBudgetError("VISION_IMAGE_LIMIT", `A message can contain at most ${settings.maxImagesPerMessage} images.`);
  if (sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) throw new ImageBudgetError("VISION_IMAGE_INVALID", "The image is empty or has an invalid size.");
  if (sizes.some((size) => size > settings.maxImageBytes)) throw new ImageBudgetError("VISION_IMAGE_LIMIT", `Each image must be at most ${settings.maxImageBytes / 1024 / 1024} MiB. Resize it first.`);
  if (sizes.reduce((total, size) => total + size, 0) > settings.maxMessageImageBytes) throw new ImageBudgetError("VISION_IMAGE_LIMIT", `Images in one message must total at most ${settings.maxMessageImageBytes / 1024 / 1024} MiB.`);
}

export function base64ImageSize(data: string, maxBytes = DEFAULT_VISION_ROUTING_SETTINGS.maxImageBytes): number {
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new ImageBudgetError("VISION_IMAGE_LIMIT", `The image exceeds the ${maxBytes / 1024 / 1024} MiB limit.`);
  if (!data || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new ImageBudgetError("VISION_IMAGE_INVALID", "The image data is not valid Base64.");
  const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > maxBytes) throw new ImageBudgetError("VISION_IMAGE_LIMIT", "The image exceeds the size limit.");
  return size;
}

export function assertImageAttachments(attachments: readonly { readonly kind: string; readonly data?: string }[], settings = DEFAULT_VISION_ROUTING_SETTINGS): void {
  assertImageSizes(attachments.filter((item) => item.kind === "image").map((item) => base64ImageSize(item.data ?? "", settings.maxImageBytes)), settings);
}

export function assertImageDimensions(width: number, height: number, settings = DEFAULT_VISION_ROUTING_SETTINGS): void {
  if (!width || !height || width > settings.maxImageDimension || height > settings.maxImageDimension || width * height > settings.maxImagePixels) {
    throw new ImageBudgetError("VISION_IMAGE_LIMIT", "The image exceeds the allowed dimensions or pixel count. Resize it first.");
  }
}

export interface ImageMetadata { readonly mimeType: string; readonly width: number; readonly height: number; readonly animated: boolean; }

export function assertImageMetadata(bytes: Uint8Array, mimeType: string, settings: VisionRoutingSettings = DEFAULT_VISION_ROUTING_SETTINGS): ImageMetadata {
  const info = imageMetadata(bytes);
  if (info.mimeType !== mimeType.toLowerCase().replace("image/jpg", "image/jpeg")) throw invalidImage();
  assertImageDimensions(info.width, info.height, settings);
  if (info.animated) throw new ImageBudgetError("VISION_ANIMATED_IMAGE", "Animated images are not analyzed as video. Convert the desired frame to a static PNG or JPEG.");
  return info;
}

/** Inspect bounded container headers before any bitmap decoder allocates pixels. */
export function imageMetadata(bytes: Uint8Array): ImageMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const u16 = (offset: number, little = true) => view.getUint16(offset, little);
  const u24 = (offset: number) => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    if (ascii(12, 16) !== "IHDR") throw invalidImage();
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw invalidImage();
      if (ascii(offset + 4, offset + 8) === "acTL") animated = true;
      offset += length + 12;
    }
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20), animated };
  }
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
    const width = u16(6), height = u16(8);
    let offset = 13 + (bytes[10]! & 0x80 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
    let frames = 0;
    const skipBlocks = () => {
      while (offset < bytes.length) {
        const length = bytes[offset++]!;
        if (!length) return;
        offset += length;
      }
      throw invalidImage();
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b && frames) return { mimeType: "image/gif", width, height, animated: frames > 1 };
      if (marker === 0x21) { offset++; skipBlocks(); continue; }
      if (marker !== 0x2c || offset + 9 > bytes.length) throw invalidImage();
      if (u16(offset) + u16(offset + 4) > width || u16(offset + 2) + u16(offset + 6) > height) throw invalidImage();
      const flags = bytes[offset + 8]!;
      offset += 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      skipBlocks();
      if (++frames > 1) return { mimeType: "image/gif", width, height, animated: true };
    }
    throw invalidImage();
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const kind = ascii(12, 16);
    if (kind === "VP8X") return { mimeType: "image/webp", width: u24(24) + 1, height: u24(27) + 1, animated: Boolean(bytes[20]! & 2) };
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { mimeType: "image/webp", width: u16(26) & 0x3fff, height: u16(28) & 0x3fff, animated: false };
    if (kind === "VP8L" && bytes[20] === 0x2f) return { mimeType: "image/webp", width: 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!), height: 1 + (((bytes[24]! & 0xf) << 10) | (bytes[23]! << 2) | (bytes[22]! >> 6)), animated: false };
    throw invalidImage();
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalidImage();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker! >= 0xd0 && marker! <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const size = u16(offset, false);
      if (size < 2 || offset + size > bytes.length) throw invalidImage();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!) && size >= 8) return { mimeType: "image/jpeg", height: u16(offset + 3, false), width: u16(offset + 5, false), animated: false };
      offset += size;
    }
  }
  throw invalidImage();
}

function invalidImage(): ImageBudgetError { return new ImageBudgetError("VISION_IMAGE_INVALID", "The file is not a supported valid image or does not match its file type."); }
