import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { net } from "electron";
import { DEFAULT_VISION_ROUTING_SETTINGS, type VisionRoutingSettings } from "@pi-gui/session-driver/vision-types";
import { assertVisionActive, VisionError, type VisionServices } from "@pi-gui/pi-sdk-driver/vision";
import { JsonFileStore } from "./json-file-store";
import { VisionStore } from "./vision-store";
import { readMigratedVisionSettings } from "./vision-settings";

export class VisionService {
  readonly store: VisionStore;
  readonly dependencies: VisionServices;
  private readonly settingsFile: JsonFileStore<unknown>;
  private settings = DEFAULT_VISION_ROUTING_SETTINGS;

  constructor(userDataDir: string) {
    this.store = new VisionStore(userDataDir);
    this.settingsFile = new JsonFileStore(userDataDir, "vision-settings");
    this.dependencies = {
      profileScopeId: this.store.profileScopeId, store: this.store, getSettings: () => this.settings,
      // Electron uses the app/system proxy and normal certificate verification.
      fetch: (url, init) => net.fetch(url instanceof URL ? url.toString() : typeof url === "string" ? url : url.url, init),
      prepareImage: (image, settings, signal, crop) => {
        assertVisionActive(signal);
        if (image.data.length > Math.ceil(settings.maxImageBytes / 3) * 4 + 4) throw new VisionError("VISION_IMAGE_LIMIT", "The image exceeds the upload limit.");
        return new Promise((resolve, reject) => {
          const worker = new Worker(join(__dirname, "vision-image-worker.mjs"), {
            workerData: { image, settings, crop }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
          });
          let settled = false;
          const finish = (error?: Error, result?: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            void worker.terminate();
            if (error) reject(error); else resolve(result as Awaited<ReturnType<VisionServices["prepareImage"]>>);
          };
          const abort = () => {
            try { assertVisionActive(signal); } catch (error) { finish(error as Error); }
          };
          signal.addEventListener("abort", abort, { once: true });
          worker.once("message", (message) => {
            if (signal.aborted) return abort();
            if (message.error) finish(new VisionError(message.error.code, message.error.message));
            else finish(undefined, message.result);
          });
          worker.once("error", () => finish(new VisionError("VISION_IMAGE_INVALID", "The image worker could not decode this file.")));
          worker.once("exit", () => { if (!settled) finish(new VisionError("VISION_IMAGE_INVALID", "The image worker stopped before completing.")); });
        });
      },
    };
  }

  async initialize(): Promise<void> {
    this.settings = await readMigratedVisionSettings(this.settingsFile);
  }

  readSettings(): VisionRoutingSettings { return { ...this.settings }; }

  async setEnabled(enabled: boolean): Promise<VisionRoutingSettings> {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    const settings = { ...this.settings, enabled };
    await this.settingsFile.write("settings", settings);
    this.settings = settings;
    return this.readSettings();
  }
}
