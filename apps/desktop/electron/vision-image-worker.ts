import { parentPort, workerData } from "node:worker_threads";
import { prepareVisionImageBytes } from "./vision-image";
import { VisionError } from "@pi-gui/pi-sdk-driver/vision";
import { ImageBudgetError } from "@pi-gui/session-driver/image-budget";

try {
  parentPort?.postMessage({ result: prepareVisionImageBytes(workerData.image, workerData.settings, workerData.crop) });
} catch (error) {
  const known = error instanceof VisionError || error instanceof ImageBudgetError;
  parentPort?.postMessage({ error: { code: known ? error.code : "VISION_IMAGE_INVALID", message: known ? error.message : "The image could not be processed." } });
}
