import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRef } from "@pi-gui/session-driver";
import type { VisionEvidenceBody, VisionSessionRecord } from "@pi-gui/session-driver/vision-types";
import { emptyVisionSession, VisionError, validateVisionEvidence, type VisionPersistence } from "@pi-gui/pi-sdk-driver/vision";
import { JsonFileStore } from "./json-file-store";

/** Serializes read-modify-write, in addition to JsonFileStore's atomic publication. */
export class VisionStore implements VisionPersistence {
  private readonly files: JsonFileStore<VisionSessionRecord>;
  private readonly queue = new Map<string, Promise<unknown>>();
  readonly profileScopeId: string;

  constructor(private readonly userDataDir: string, profileScopeId?: string) {
    this.profileScopeId = profileScopeId ?? createHash("sha256").update(userDataDir).digest("hex");
    this.files = new JsonFileStore(userDataDir, "vision-records");
  }

  async read(ref: SessionRef): Promise<VisionSessionRecord | undefined> {
    const key = this.key(ref);
    try {
      const value = await this.files.read(key);
      if (value === undefined) {
        // An inaccessible/corrupt existing record is not an empty new session.
        // Refuse to overwrite it; JsonFileStore already attempts backup recovery.
        const file = join(this.userDataDir, "vision-records", createHash("sha256").update(key).digest("hex") + ".json");
        for (const suffix of ["", ".bak"]) {
          try { await access(file + suffix); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          throw new Error("Unrecoverable vision record");
        }
        return undefined;
      }
      this.validate(ref, value);
      return value;
    } catch {
      throw new VisionError("VISION_STORAGE", "Saved image evidence could not be read. Check storage permissions before retrying.", true);
    }
  }

  async update(ref: SessionRef, change: (current: VisionSessionRecord) => VisionSessionRecord): Promise<VisionSessionRecord> {
    try { return await this.serialize(this.key(ref), async () => {
      const before = await this.read(ref) ?? emptyVisionSession(this.profileScopeId, ref);
      const next = change(before);
      this.validate(ref, next);
      await this.files.write(this.key(ref), next);
      return next;
    }); } catch {
      throw new VisionError("VISION_STORAGE", "Image evidence could not be saved. Original images are retained; check storage permissions and retry.", true);
    }
  }

  async remove(ref: SessionRef): Promise<void> {
    await this.serialize(this.key(ref), () => this.files.remove(this.key(ref)));
  }

  private key(ref: SessionRef): string { return JSON.stringify([this.profileScopeId, ref.workspaceId, ref.sessionId]); }

  private validate(ref: SessionRef, value: VisionSessionRecord): void {
    if (value.version !== 1 || value.profileScopeId !== this.profileScopeId || value.sessionRef?.workspaceId !== ref.workspaceId || value.sessionRef?.sessionId !== ref.sessionId ||
      !Array.isArray(value.images) || !Array.isArray(value.evidence) || !Array.isArray(value.operations) || !Array.isArray(value.submissions)) {
      throw new Error("Invalid vision record scope or version");
    }
    for (const item of value.evidence) {
      if (item.profileScopeId !== this.profileScopeId || item.sessionRef.workspaceId !== ref.workspaceId || item.sessionRef.sessionId !== ref.sessionId) throw new Error("Invalid evidence scope");
      validateVisionEvidence(item.body, item.body.images.map((image: VisionEvidenceBody["images"][number]) => image.imageId));
    }
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queue.set(key, next);
    try { return await next; } finally { if (this.queue.get(key) === next) this.queue.delete(key); }
  }
}
