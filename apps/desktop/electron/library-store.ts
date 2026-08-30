import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LibrarySettings {
  readonly enabled: boolean;
  readonly roots: readonly string[];
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  enabled: false,
  roots: [],
};

export function normalizeLibrarySettings(raw: unknown): LibrarySettings {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_LIBRARY_SETTINGS;
  }

  const input = raw as Partial<Record<keyof LibrarySettings, unknown>>;
  const roots = Array.isArray(input.roots)
    ? input.roots
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
        .map((entry) => path.normalize(entry))
        .filter((entry, index, all) => all.indexOf(entry) === index)
    : [];

  return {
    enabled: input.enabled === true,
    roots,
  };
}

export class LibraryStore {
  private readonly filePath: string;
  private cached: LibrarySettings | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): LibrarySettings {
    if (this.cached) {
      return this.cached;
    }
    this.cached = this.readFromDisk();
    return this.cached;
  }

  write(next: LibrarySettings): LibrarySettings {
    const normalized = normalizeLibrarySettings(next);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this.cached = normalized;
    return normalized;
  }

  private readFromDisk(): LibrarySettings {
    try {
      return normalizeLibrarySettings(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      return DEFAULT_LIBRARY_SETTINGS;
    }
  }
}
