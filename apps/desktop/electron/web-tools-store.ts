import type { SafeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_WEB_TOOLS_SETTINGS,
  normalizeWebToolsSettings,
  type WebToolsSettings,
} from "./web-search";

interface PersistedWebToolsSettings extends Omit<WebToolsSettings, "apiKey"> {
  /** base64 of the safeStorage-encrypted key. Absent when no key is stored. */
  readonly encryptedApiKey?: string;
}

/**
 * Persists web-access settings, keeping the search API key encrypted at rest via
 * Electron `safeStorage` (DPAPI on Windows, Keychain on macOS).
 *
 * Mirrors the deliberate stance of `SecureAuthStorageBackend`: when encryption
 * is unavailable the key is NOT written in plaintext as a fallback. Everything
 * else about the settings still persists — only the secret is dropped, and the
 * user is told, rather than silently getting a credential file they did not
 * agree to.
 */
export class WebToolsStore {
  private readonly safeStorage: SafeStorage;
  private readonly filePath: string;
  private cached: WebToolsSettings | undefined;

  constructor(safeStorage: SafeStorage, filePath: string) {
    this.safeStorage = safeStorage;
    this.filePath = filePath;
  }

  /**
   * Reads through an in-memory cache: the agent tools call this on every tool
   * invocation, and re-reading/decrypting the file each time would put a
   * synchronous disk read on the model's critical path.
   */
  read(): WebToolsSettings {
    if (this.cached) {
      return this.cached;
    }
    this.cached = this.readFromDisk();
    return this.cached;
  }

  write(settings: WebToolsSettings): WebToolsSettings {
    const normalized = normalizeWebToolsSettings(settings);
    const { apiKey, ...rest } = normalized;

    let encryptedApiKey: string | undefined;
    let storedApiKey = apiKey;
    if (apiKey) {
      if (this.safeStorage.isEncryptionAvailable()) {
        encryptedApiKey = this.safeStorage.encryptString(apiKey).toString("base64");
      } else {
        // Refuse to persist rather than write a secret in the clear.
        storedApiKey = "";
        console.warn("[web-tools] encryption unavailable; the search API key was not saved to disk.");
      }
    }

    const payload: PersistedWebToolsSettings = {
      ...rest,
      ...(encryptedApiKey ? { encryptedApiKey } : {}),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    // Keep the live key in memory even when it could not be encrypted, so the
    // current session still works; it simply will not survive a restart.
    this.cached = { ...normalized, apiKey: storedApiKey || apiKey };
    return this.cached;
  }

  /** True when a key is set — used to render "saved" without exposing the secret. */
  hasApiKey(): boolean {
    return this.read().apiKey.length > 0;
  }

  private readFromDisk(): WebToolsSettings {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return DEFAULT_WEB_TOOLS_SETTINGS;
    }

    let parsed: PersistedWebToolsSettings;
    try {
      parsed = JSON.parse(raw) as PersistedWebToolsSettings;
    } catch (error) {
      console.warn("[web-tools] settings file is unreadable; falling back to defaults:", error);
      return DEFAULT_WEB_TOOLS_SETTINGS;
    }

    let apiKey = "";
    if (parsed.encryptedApiKey && this.safeStorage.isEncryptionAvailable()) {
      try {
        apiKey = this.safeStorage.decryptString(Buffer.from(parsed.encryptedApiKey, "base64"));
      } catch (error) {
        // A key encrypted under a different OS user or machine cannot be read
        // back. Treat it as absent so the UI prompts for it again.
        console.warn("[web-tools] stored search API key could not be decrypted:", error);
      }
    }

    return normalizeWebToolsSettings({ ...parsed, apiKey });
  }
}
