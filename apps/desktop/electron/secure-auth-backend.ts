import type { SafeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import {
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
} from "@pi-gui/pi-sdk-driver/custom-provider-types";

/**
 * Encrypted credentials backend for API keys.
 *
 * Splits credential storage by type so that only API keys are encrypted:
 * - `api_key` credentials → encrypted into `secureKeysPath` via Electron
 *   `safeStorage` (OS-keychain-backed). Plaintext keys never touch disk.
 * - `oauth` credentials → persisted as plaintext JSON into `authJsonPath`
 *   (the standard pi auth.json), preserving SDK OAuth login/refresh and
 *   interoperability with the pi CLI.
 *
 * Implements Pi's `CredentialStore` contract while retaining a combined JSON
 * view internally so each serialized update can be routed by credential type.
 *
 * `safeStorage` must come from the Electron main process (constructor arg).
 */
type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
type AuthOperationOptions = Parameters<CredentialStore["read"]>[1];

export class SecureAuthStorageBackend implements CredentialStore {
  private readonly safeStorage: SafeStorage;
  private readonly secureKeysPath: string;
  private readonly authJsonPath: string;
  private readonly modelsJsonPath?: string;
  /**
   * In-process serialization guard. The SDK's own FileAuthStorageBackend
   * serializes readers/writers with proper-lockfile; because we split state
   * across two files we cannot use a single file lock, so we serialize with a
   * busy-flag instead. `withLockAsync` acquires it as a promise chain;
   * `withLock` (sync, cannot await) spin-waits briefly while an async op is in
   * flight, mirroring the SDK's sync lockSync retry. This prevents the OAuth
   * refresh's async read-modify-write from clobbering a concurrent key set.
   */
  /**
   * Async serialization guard. The SDK's own FileAuthStorageBackend serializes
   * concurrent operations with proper-lockfile; we split state across two files
   * and cannot use a single file lock, so `withLockAsync` (used by OAuth token
   * refresh, which awaits a network call inside the lock) is serialized through
   * a promise chain so two refreshes never run their read-modify-write windows
   * concurrently. Synchronous `withLock` calls (quick set/remove) run without
   * awaiting, matching the SDK's short synchronous paths.
   */
  private lockQueue: Promise<void> = Promise.resolve();

  constructor(safeStorage: SafeStorage, secureKeysPath: string, authJsonPath: string, modelsJsonPath?: string) {
    this.safeStorage = safeStorage;
    this.secureKeysPath = secureKeysPath;
    this.authJsonPath = authJsonPath;
    this.modelsJsonPath = modelsJsonPath;
  }

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    const current = this.readMerged();
    const { result, next } = fn(current);
    if (next !== undefined) {
      this.writeSplit(next);
    }
    return result;
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
  ): Promise<T> {
    // Chain onto the previous async op so overlapping withLockAsync calls are
    // fully serialized (their merged read reflects the prior write).
    const run = this.lockQueue.then(async () => {
      const current = this.readMerged();
      const { result, next } = await fn(current);
      if (next !== undefined) {
        this.writeSplit(next);
      }
      return result;
    });
    // Keep the queue alive for the next caller regardless of this run's outcome.
    this.lockQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const credential = parseCredentials(this.readMerged())[providerId];
    options?.signal?.throwIfAborted();
    return credential ? structuredClone(credential) : undefined;
  }

  /**
   * Synchronous API-key lookup for callers that cannot await.
   *
   * The web-search backend reads settings on the model's critical path through a
   * synchronous getter, and DeepSeek search authenticates with the DeepSeek
   * *model* key rather than a separately entered one. Everything `read` does is
   * synchronous underneath, so this exposes that without duplicating the
   * decryption path. Returns "" when the provider has no key credential — an
   * OAuth-authenticated provider deliberately yields nothing here.
   */
  readApiKeySync(providerId: string): string {
    const credential = parseCredentials(this.readMerged())[providerId];
    if (!credential || credential.type !== "api_key") {
      return "";
    }
    return typeof credential.key === "string" ? credential.key.trim() : "";
  }

  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const credentials = parseCredentials(this.readMerged());
    options?.signal?.throwIfAborted();
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.withLockAsync(async (current) => {
      options?.signal?.throwIfAborted();
      const credentials = parseCredentials(current);
      const nextCredential = await fn(credentials[providerId]);
      options?.signal?.throwIfAborted();
      if (nextCredential === undefined) {
        return { result: credentials[providerId] };
      }
      credentials[providerId] = nextCredential;
      return { result: nextCredential, next: JSON.stringify(credentials, null, 2) };
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.withLockAsync(async (current) => {
      options?.signal?.throwIfAborted();
      const credentials = parseCredentials(current);
      delete credentials[providerId];
      return { result: undefined, next: JSON.stringify(credentials, null, 2) };
    });
  }

  /**
   * Merge both physical sources into a single combined JSON object (as a
   * string used by the serialized credential update helpers).
   */
  private readMerged(): string | undefined {
    const keys = this.readSecureKeys();
    const oauth = this.readAuthJson();
    const combined: Record<string, unknown> = {};
    for (const [providerId, credential] of Object.entries(keys)) {
      combined[providerId] = credential;
    }
    for (const [providerId, credential] of Object.entries(oauth)) {
      combined[providerId] = credential;
    }
    if (Object.keys(combined).length === 0) {
      return undefined;
    }
    return JSON.stringify(combined, null, 2);
  }

  /**
   * Write the combined data back, routing each credential by type.
   */
  private writeSplit(next: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(next) as Record<string, unknown>;
    } catch {
      // The SDK already updated its in-memory state; silently dropping the
      // write here would let memory and disk diverge indefinitely. Surface it.
      throw new Error("SecureAuthStorageBackend: failed to parse store update; write aborted.");
    }

    const keys: Record<string, unknown> = {};
    const oauth: Record<string, unknown> = {};
    for (const [providerId, credential] of Object.entries(data)) {
      if (credential && typeof credential === "object" && (credential as { type?: unknown }).type === "oauth") {
        oauth[providerId] = credential;
      } else {
        keys[providerId] = credential;
      }
    }

    this.writeSecureKeys(keys);
    // force = true: `next` is always a full-store replacement, so an empty
    // OAuth set is an intentional removal that must be persisted (logout of
    // the last OAuth provider, or a migration scrub leaving no OAuth).
    this.writeAuthJson(oauth, true);
  }

  private readSecureKeys(): Record<string, unknown> {
    let raw: string;
    try {
      raw = readFileSync(this.secureKeysPath, "utf8");
    } catch {
      return {};
    }
    if (!raw.trim()) {
      return {};
    }
    try {
      const encryptedMap = JSON.parse(raw) as Record<string, string>;
      const result: Record<string, unknown> = {};
      for (const [providerId, ciphertext] of Object.entries(encryptedMap)) {
        if (this.safeStorage.isEncryptionAvailable()) {
          try {
            const plaintext = this.safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
            result[providerId] = JSON.parse(plaintext) as unknown;
          } catch {
            // Skip undecryptable entries (e.g. keychain re-encrypted after OS
            // account migration); the provider simply reads as unauthenticated.
          }
        } else {
          try {
            result[providerId] = JSON.parse(Buffer.from(ciphertext, "base64").toString("utf8")) as unknown;
          } catch {
            // Ignore malformed entries.
          }
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private writeSecureKeys(keys: Record<string, unknown>): void {
    if (Object.keys(keys).length === 0) {
      // Nothing to encrypt; ensure no stale encrypted file lingers.
      this.writeJson(this.secureKeysPath, {});
      return;
    }
    if (!this.encryptionUsable()) {
      // Never fall back to trivially-reversible base64. If OS keychain
      // encryption is unavailable or degraded, refuse to persist the key
      // rather than silently writing effectively-plaintext credentials.
      throw new Error(
        "Secure credential storage is unavailable on this system (OS keychain encryption is " +
          "not available). API keys were not saved. Set your keys via environment variables instead.",
      );
    }
    const encryptedMap: Record<string, string> = {};
    for (const [providerId, credential] of Object.entries(keys)) {
      if (credential === undefined) {
        continue;
      }
      const plaintext = JSON.stringify(credential);
      encryptedMap[providerId] = this.safeStorage.encryptString(plaintext).toString("base64");
    }
    this.writeJson(this.secureKeysPath, encryptedMap);
  }

  /**
   * Whether OS-keychain-backed encryption is genuinely usable. Linux's
   * `basic_text` backend is obfuscation (hardcoded key), not encryption; treat
   * it as unavailable so keys are not silently stored recoverably.
   */
  private encryptionUsable(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return false;
    }
    try {
      const backend = this.safeStorage.getSelectedStorageBackend();
      if (backend === "basic_text") {
        return false;
      }
    } catch {
      // getSelectedStorageBackend may be absent on older Electron; trust
      // isEncryptionAvailable() as the gate in that case.
    }
    return true;
  }

  private readAuthJson(): Record<string, unknown> {
    try {
      const raw = readFileSync(this.authJsonPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeAuthJson(oauth: Record<string, unknown>, force = false): void {
    if (Object.keys(oauth).length === 0 && !force) {
      // Preserve the pi CLI's auth.json if it has no OAuth entries we own and
      // this is a routine write; leaving it untouched avoids clobbering state
      // the CLI may still be using. Callers that must reflect a removal
      // (logout, migration scrub) pass force = true to empty the file.
      return;
    }
    if (Object.keys(oauth).length === 0 && force) {
      // The SDK's `next` is always a full-store replacement; an empty OAuth set
      // means the caller removed the last OAuth credential. Write an empty
      // object so the removal is persisted instead of resurrecting on reload.
      this.writeJson(this.authJsonPath, {});
      return;
    }
    this.writeJson(this.authJsonPath, oauth);
  }

  /**
   * One-time migration: import plaintext `api_key` credentials from the
   * legacy auth.json into the encrypted store, then scrub them from auth.json
   * so plaintext keys no longer sit on disk. OAuth entries are left untouched
   * (they stay in auth.json for SDK/CLI compatibility).
   *
   * Returns the number of keys imported. Safe to call on every startup — it is
   * a no-op once the encrypted store already holds a key for a provider.
   */
  migratePlaintextKeys(): number {
    let imported = 0;
    imported += this.migrateAuthJsonKeys();
    imported += this.migrateModelsJsonKeys();
    return imported;
  }

  /**
   * Absorb plaintext `api_key` credentials from the legacy auth.json into the
   * encrypted store, then scrub them from auth.json (OAuth preserved). Safe to
   * run every startup; idempotent once a provider's key is already encrypted.
   */
  private migrateAuthJsonKeys(): number {
    const legacy = this.readAuthJson();
    let imported = 0;
    for (const [providerId, credential] of Object.entries(legacy)) {
      if (
        credential &&
        typeof credential === "object" &&
        (credential as { type?: unknown }).type === "api_key"
      ) {
        const secure = this.readSecureKeys();
        if (!(providerId in secure)) {
          this.writeSecureKeys({ ...secure, [providerId]: credential });
          imported += 1;
        }
      }
    }
    if (imported > 0) {
      // Scrub the imported api_key entries from auth.json, keeping OAuth.
      const oauth: Record<string, unknown> = {};
      for (const [providerId, credential] of Object.entries(legacy)) {
        if (
          credential &&
          typeof credential === "object" &&
          (credential as { type?: unknown }).type !== "api_key"
        ) {
          oauth[providerId] = credential;
        }
      }
      // force = true so the imported api_key entries are scrubbed even when no
      // OAuth entries remain (the migration's whole point is removing the
      // plaintext keys from the shared auth.json).
      this.writeAuthJson(oauth, true);
    }
    return imported;
  }

  /**
   * Absorb plaintext custom-endpoint keys that a pre-encryption build wrote
   * into models.json, then rewrite those entries with the placeholder so no
   * plaintext key remains in the model catalog.
   */
  private migrateModelsJsonKeys(): number {
    if (!this.modelsJsonPath) {
      return 0;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(this.modelsJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      return 0;
    }
    const providers = data.providers;
    if (!providers || typeof providers !== "object") {
      return 0;
    }
    const entries = Object.entries(providers as Record<string, unknown>);
    let imported = 0;
    let mutated = false;
    const secure = this.readSecureKeys();
    for (const [providerId, config] of entries) {
      if (!config || typeof config !== "object") {
        continue;
      }
      const cfg = config as Record<string, unknown>;
      // Only pi-gui-managed custom endpoints (guarded by the marker or the
      // openai-completions shape); skip built-ins whose apiKey is intentional.
      if (cfg[PI_GUI_CUSTOM_PROVIDER_MARKER] !== true) {
        continue;
      }
      const rawKey = typeof cfg.apiKey === "string" ? cfg.apiKey : undefined;
      if (!rawKey || rawKey === CUSTOM_PROVIDER_PLACEHOLDER_API_KEY) {
        continue;
      }
      if (!(providerId in secure)) {
        this.writeSecureKeys({ ...secure, [providerId]: { type: "api_key", key: rawKey } });
        secure[providerId] = { type: "api_key", key: rawKey };
        imported += 1;
      }
      // Scrub the plaintext key from models.json regardless of import outcome
      // (if it was already in secure, this just removes the stale plaintext).
      if (cfg.apiKey !== CUSTOM_PROVIDER_PLACEHOLDER_API_KEY) {
        cfg.apiKey = CUSTOM_PROVIDER_PLACEHOLDER_API_KEY;
        mutated = true;
      }
    }
    if (mutated) {
      mkdirSync(dirname(this.modelsJsonPath), { recursive: true });
      writeFileSync(this.modelsJsonPath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    return imported;
  }

  private writeJson(path: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function parseCredentials(raw: string | undefined): Record<string, Credential> {
  if (!raw?.trim()) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SecureAuthStorageBackend: invalid credential store data.");
  }
  return parsed as Record<string, Credential>;
}
