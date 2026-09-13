import { DEFAULT_VISION_ROUTING_SETTINGS, type VisionRoutingSettings } from "@pi-gui/session-driver/vision-types";
import type { JsonFileStore } from "./json-file-store";

/** Policies are application-owned; only the user's explicit toggle is mutable.
 * JsonFileStore keeps an atomic backup. Evidence records are never migrated. */
export async function readMigratedVisionSettings(store: Pick<JsonFileStore<unknown>, "read" | "write">): Promise<VisionRoutingSettings> {
  const saved = await store.read("settings");
  const enabled = saved && typeof saved === "object" && "enabled" in saved && typeof saved.enabled === "boolean" ? saved.enabled : true;
  const settings = { ...DEFAULT_VISION_ROUTING_SETTINGS, enabled };
  if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(settings)) {
    try { await store.write("settings", settings); }
    catch (error) { console.warn("[vision-settings] Could not persist the model alias migration; the existing file is retained and migration will retry on startup.", error); }
  }
  return settings;
}
