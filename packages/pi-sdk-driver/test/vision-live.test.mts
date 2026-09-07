import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VISION_ROUTING_SETTINGS } from "@pi-gui/session-driver/vision-types";
import { VisionClient } from "../dist/vision-client.js";

// Explicit, paid opt-in using a dedicated test account and a synthetic 8×8 PNG.
// Never reads the user's saved provider credentials or prints OCR/server bodies.
test("official DeepSeek small-image live contract", {
  skip: process.env.PI_APP_TEST_LIVE_VISION !== "1" && "Set PI_APP_TEST_LIVE_VISION=1 and PI_APP_TEST_VISION_API_KEY to opt into a paid request.",
  timeout: 65_000,
}, async () => {
  const apiKey = process.env.PI_APP_TEST_VISION_API_KEY;
  assert.ok(apiKey?.trim(), "A dedicated test account key is required in PI_APP_TEST_VISION_API_KEY.");
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGPQSLnzHx9mGBkKAOz6mcHK/OviAAAAAElFTkSuQmCC";
  const settings = { ...DEFAULT_VISION_ROUTING_SETTINGS, maxAttempts: 1, totalTimeoutMs: 60_000 };
  const result = await new VisionClient(fetch).recognize({
    images: [{ imageId: "img-live-test", mimeType: "image/png", data, bytes: Buffer.from(data, "base64").length, width: 8, height: 8 }],
    question: "Describe only the visible color in this synthetic test image.", contextText: "Non-sensitive connectivity fixture.",
    apiKey, settings, signal: AbortSignal.timeout(settings.totalTimeoutMs),
    budget: { deadline: Date.now() + settings.totalTimeoutMs, attempts: 0, repairAttempted: false, largerOutputAttempted: false },
  });
  assert.equal(result.body.schemaVersion, 1);
  assert.equal(result.body.images.length, 1);
  assert.equal(result.body.images[0].imageId, "img-live-test");
});
