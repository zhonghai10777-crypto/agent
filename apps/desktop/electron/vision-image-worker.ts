import { parentPort, workerData } from "node:worker_threads";
import { prepareVisionImageBytes } from "./vision-image";
import { VisionError } from "@pi-gui/pi-sdk-driver/vision";

try {
  parentPort?.postMessage({ result: prepareVisionImageBytes(workerData.image, workerData.settings, workerData.crop) });
} catch (error) {
  parentPort?.postMessage({ error: { code: error instanceof VisionError ? error.code : "VISION_IMAGE_INVALID", message: error instanceof VisionError ? error.message : "The image could not be processed." } });
}
