import { assertImageMetadata, ImageBudgetError } from "@pi-gui/session-driver/image-budget";
export { imageMetadata } from "@pi-gui/session-driver/image-budget";
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
  const metadata = assertImageMetadata(bytes, input.mimeType, settings);
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
    if (error instanceof VisionError || error instanceof ImageBudgetError) throw error;
    throw new VisionError("VISION_IMAGE_INVALID", "The image could not be decoded. Convert it to a static PNG, JPEG or WebP.");
  } finally { cropped?.free(); decoded?.free(); }
}
