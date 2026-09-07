import { PhotonImage, crop as cropImage } from "@silvia-odwyer/photon-node";
import { imageBytes, validateVisionCrop, VisionError, type PreparedVisionImage } from "@pi-gui/pi-sdk-driver/vision";
import type { VisionCrop, VisionRoutingSettings } from "@pi-gui/session-driver/vision-types";

export interface VisionImageInput {
  readonly imageId: string;
  readonly data: string;
  readonly mimeType: string;
}

/** Runs exclusively in the bounded image worker; inspect headers before allocating a decoded bitmap. */
export function prepareVisionImageBytes(input: VisionImageInput, settings: VisionRoutingSettings, crop?: VisionCrop): PreparedVisionImage {
  const bytes = imageBytes(input, settings.maxImageBytes);
  const metadata = imageMetadata(bytes);
  if (metadata.mimeType !== input.mimeType.toLowerCase().replace("image/jpg", "image/jpeg")) throw new VisionError("VISION_IMAGE_INVALID", "The image bytes do not match its declared file type.");
  if (!metadata.width || !metadata.height || metadata.width > settings.maxImageDimension || metadata.height > settings.maxImageDimension || metadata.width * metadata.height > settings.maxImagePixels) throw new VisionError("VISION_IMAGE_LIMIT", "The image exceeds the allowed dimensions or pixel count. Resize it first.");
  if (metadata.animated) throw new VisionError("VISION_ANIMATED_IMAGE", "Animated images are not analyzed as video. Convert the desired frame to a static PNG or JPEG.");
  let decoded: PhotonImage | undefined;
  let cropped: PhotonImage | undefined;
  try {
    decoded = PhotonImage.new_from_byteslice(bytes);
    const width = decoded.get_width();
    const height = decoded.get_height();
    if (width !== metadata.width || height !== metadata.height) throw new VisionError("VISION_IMAGE_INVALID", "Image dimensions did not match the decoded file.");
    if (!crop) return { ...input, mimeType: metadata.mimeType, bytes: bytes.length, width, height };
    validateVisionCrop(crop);
    const x1 = Math.floor(crop.x * width);
    const y1 = Math.floor(crop.y * height);
    const x2 = Math.min(width, Math.ceil((crop.x + crop.width) * width));
    const y2 = Math.min(height, Math.ceil((crop.y + crop.height) * height));
    if (x2 <= x1 || y2 <= y1) throw new VisionError("VISION_IMAGE_INVALID", "The crop contains no pixels.");
    cropped = cropImage(decoded, x1, y1, x2, y2);
    const result = Buffer.from(cropped.get_bytes());
    if (result.length > settings.maxImageBytes) throw new VisionError("VISION_IMAGE_LIMIT", "The cropped image exceeds the upload limit.");
    return { imageId: input.imageId, mimeType: "image/png", data: result.toString("base64"), bytes: result.length, width: x2 - x1, height: y2 - y1 };
  } catch (error) {
    if (error instanceof VisionError) throw error;
    throw new VisionError("VISION_IMAGE_INVALID", "The image could not be decoded. Convert it to a static PNG, JPEG or WebP.");
  } finally { cropped?.free(); decoded?.free(); }
}

export function imageMetadata(bytes: Buffer): { mimeType: string; width: number; height: number; animated: boolean } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR") throw invalidImage();
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw invalidImage();
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") animated = true;
      offset += length + 12;
    }
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), animated };
  }
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return gifMetadata(bytes);
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") return { mimeType: "image/webp", width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1, animated: Boolean(bytes[20]! & 2) };
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, animated: false };
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
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) throw invalidImage();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!) && size >= 8) return { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5), animated: false };
      offset += size;
    }
  }
  throw invalidImage();
}

function invalidImage(): VisionError { return new VisionError("VISION_IMAGE_INVALID", "The file is not a supported valid image."); }

function gifMetadata(bytes: Buffer): { mimeType: string; width: number; height: number; animated: boolean } {
  if (bytes.length < 13) throw invalidImage();
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  let offset = 13 + (bytes[10]! & 0x80 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
  let frames = 0;
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++]!;
      if (length === 0) return;
      offset += length;
      if (offset > bytes.length) throw invalidImage();
    }
    throw invalidImage();
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b && frames) return { mimeType: "image/gif", width, height, animated: frames > 1 };
    if (marker === 0x21) { offset++; skipBlocks(); continue; }
    if (marker !== 0x2c || offset + 9 > bytes.length) throw invalidImage();
    if (bytes.readUInt16LE(offset) + bytes.readUInt16LE(offset + 4) > width || bytes.readUInt16LE(offset + 2) + bytes.readUInt16LE(offset + 6) > height) throw invalidImage();
    const flags = bytes[offset + 8]!;
    offset += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
    offset++; // LZW minimum code size; decoding is still delegated to Photon.
    skipBlocks();
    frames++;
    if (frames > 1) return { mimeType: "image/gif", width, height, animated: true };
  }
  throw invalidImage();
}
