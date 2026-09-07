import { expect, test } from "@playwright/test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { DEFAULT_VISION_ROUTING_SETTINGS } from "@pi-gui/session-driver/vision-types";
import { imageMetadata, prepareVisionImageBytes } from "../../electron/vision-image";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGPQSLnzHx9mGBkKAOz6mcHK/OviAAAAAElFTkSuQmCC";
const input = { imageId: "img-fixture", data: png, mimeType: "image/png" };
const settings = DEFAULT_VISION_ROUTING_SETTINGS;

test("the worker decoder validates a real static image and crops normalized regions", () => {
  const prepared = prepareVisionImageBytes(input, settings);
  expect([prepared.width, prepared.height]).toEqual([8, 8]);
  expect(prepared.data).toBe(png);
  const cropped = prepareVisionImageBytes(input, settings, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  expect([cropped.width, cropped.height]).toEqual([4, 4]);
  expect(imageMetadata(Buffer.from(cropped.data, "base64"))).toMatchObject({ width: 4, height: 4, mimeType: "image/png", animated: false });
  const decoded = PhotonImage.new_from_byteslice(Buffer.from(cropped.data, "base64"));
  try { expect(decoded.get_width()).toBe(4); } finally { decoded.free(); }
});

test("spoofed MIME, malformed data, oversized pixels, excessive bytes and invalid crops are rejected before upload", () => {
  expect(() => prepareVisionImageBytes({ ...input, mimeType: "image/jpeg" }, settings)).toThrow("VISION_IMAGE_INVALID");
  expect(() => prepareVisionImageBytes({ ...input, data: Buffer.from("not an image").toString("base64") }, settings)).toThrow("VISION_IMAGE_INVALID");
  const huge = Buffer.from(png, "base64");
  huge.writeUInt32BE(9000, 16);
  expect(() => prepareVisionImageBytes({ ...input, data: huge.toString("base64") }, settings)).toThrow("VISION_IMAGE_LIMIT");
  expect(() => prepareVisionImageBytes(input, { ...settings, maxImageBytes: 10 })).toThrow();
  for (const crop of [{ x: -0.1, y: 0, width: 0.5, height: 0.5 }, { x: 0.8, y: 0, width: 0.5, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) {
    expect(() => prepareVisionImageBytes(input, settings, crop)).toThrow("VISION_IMAGE_INVALID");
  }
});

test("animated PNG is rejected with an explicit static-frame instruction", () => {
  const original = Buffer.from(png, "base64");
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write("acTL", 4, "ascii");
  const animated = Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
  expect(() => prepareVisionImageBytes({ ...input, data: animated.toString("base64") }, settings)).toThrow("VISION_ANIMATED_IMAGE");
});

test("real JPEG, WebP and static GIF decode while animated GIF is rejected", () => {
  const decoded = PhotonImage.new_from_byteslice(Buffer.from(png, "base64"));
  try {
    for (const [mimeType, data] of [["image/jpeg", decoded.get_bytes_jpeg(80)], ["image/webp", decoded.get_bytes_webp()]] as const) {
      const prepared = prepareVisionImageBytes({ ...input, mimeType, data: Buffer.from(data).toString("base64") }, settings);
      expect([prepared.width, prepared.height, prepared.mimeType]).toEqual([8, 8, mimeType]);
    }
  } finally { decoded.free(); }
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  expect(prepareVisionImageBytes({ ...input, mimeType: "image/gif", data: gif.toString("base64") }, settings)).toMatchObject({ width: 1, height: 1, mimeType: "image/gif" });
  const imageStart = gif.indexOf(0x2c, 19);
  const animated = Buffer.concat([gif.subarray(0, -1), gif.subarray(imageStart)]);
  expect(() => prepareVisionImageBytes({ ...input, mimeType: "image/gif", data: animated.toString("base64") }, settings)).toThrow("VISION_ANIMATED_IMAGE");
});
