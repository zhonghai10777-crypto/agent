import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { RuntimeExtensionRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { extensionSourceSummary } from "../extension-display";
import type { PiDesktopApi } from "../ipc";
import { nextMenuIndex } from "./use-slash-menu";

export type MentionOption =
  | {
      readonly kind: "extension";
      readonly id: string;
      readonly displayName: string;
      readonly description: string;
      readonly insertText: string;
      readonly enabled: boolean;
      readonly enabling: boolean;
      readonly path: string;
    }
  | {
      readonly kind: "file";
      readonly id: string;
      readonly insertText: string;
      readonly filePath: string;
    };

interface UseMentionMenuParams {
  readonly composerDraft: string;
  readonly setComposerDraft: (draft: string) => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly workspaceId: string | undefined;
  readonly runtime?: RuntimeSnapshot;
  readonly api: PiDesktopApi | undefined;
  readonly onEnableExtension?: (filePath: string) => Promise<void>;
}

export interface MentionMenuState {
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly MentionOption[];
  /** True when the underlying file scan hit a bound before finishing (see
   * listWorkspaceFiles), so the menu can note the file list may be incomplete. */
  readonly filesTruncated: boolean;
  readonly selectedIndex: number;
  readonly handleMentionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly insertMention: (option: MentionOption) => void;
  readonly enableMentionExtension: (option: Extract<MentionOption, { kind: "extension" }>) => void;
}

// Match @<query> at end of string (or preceded by whitespace)
function extractMentionQuery(text: string): { query: string; atIndex: number } | null {
  // Find the last @ that could be a mention trigger
  const match = /(?:^|\s)@([^\s]*)$/.exec(text);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const atIndex = text.length - query.length - 1; // position of @
  return { query, atIndex };
}

export function useMentionMenu({
  composerDraft,
  setComposerDraft,
  composerRef,
  workspaceId,
  runtime,
  api,
  onEnableExtension,
}: UseMentionMenuParams): MentionMenuState {
  const [allFiles, setAllFiles] = useState<readonly string[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [pendingEnablePaths, setPendingEnablePaths] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  const composerDraftRef = useRef(composerDraft);
  composerDraftRef.current = composerDraft;
  const lastFilesFetchAtRef = useRef(0);

  // Re-fetches the workspace file list, throttled client-side so rapid focus/blur or
  // repeated `@` queries within the same interaction don't hammer IPC. Deliberately
  // shorter than the main process's own 30s cache TTL (app-store-files.ts): this only
  // needs to absorb same-interaction jitter, not enforce staleness.
  //
  // `force` bypasses that main-process cache too. It defaults to false (cheap — a Map
  // lookup) for the frequent, low-stakes focus trigger, matching the "don't re-scan a
  // huge repo on every focus" goal. The query-start trigger below passes force:true:
  // the mount-time fetch and this refresh both otherwise run through the same
  // force:false cache, so a file created moments after the thread starts (the common
  // case — an agent just wrote it) would silently see the mount snapshot for up to 30s
  // without it. That's the one moment worth an actual re-scan: it's driven by the user
  // starting a new "@" query, not by every keystroke, and `git ls-files` itself is fast.
  const refreshFiles = useCallback((options?: { readonly force?: boolean }) => {
    if (!api || !workspaceId) {
      return;
    }
    const now = Date.now();
    if (!options?.force && now - lastFilesFetchAtRef.current < 3_000) {
      return;
    }
    lastFilesFetchAtRef.current = now;
    void api
      .listWorkspaceFiles(workspaceId, { force: options?.force ?? false })
      .then((result) => {
        setAllFiles(result.files);
        setFilesTruncated(result.truncated);
      })
      .catch(() => undefined);
  }, [api, workspaceId]);

  // Fetch file list when workspace changes. Deliberately doesn't touch
  // lastFilesFetchAtRef: this mount-time fetch and refreshFiles()'s throttle govern
  // different things, so the first focus/query-start refresh after mount should still
  // fire right away rather than being blocked by this unrelated initial fetch.
  useEffect(() => {
    if (!api || !workspaceId) {
      setAllFiles([]);
      setFilesTruncated(false);
      return;
    }
    void api
      .listWorkspaceFiles(workspaceId, { force: false })
      .then((result) => {
        setAllFiles(result.files);
        setFilesTruncated(result.truncated);
      })
      .catch(() => {
        setAllFiles([]);
        setFilesTruncated(false);
      });
  }, [api, workspaceId]);

  // Refresh (throttled) whenever the composer regains focus, so files created since the last
  // fetch are pickable without waiting on the main process's 30s TTL to expire on its own.
  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) {
      return undefined;
    }
    const handleFocus = () => refreshFiles();
    textarea.addEventListener("focus", handleFocus);
    return () => textarea.removeEventListener("focus", handleFocus);
  }, [composerRef, refreshFiles]);

  // Reset suppression when draft changes
  useEffect(() => {
    setSuppressed(false);
  }, [composerDraft]);

  useEffect(() => {
    setPendingEnablePaths((current) => {
      if (current.size === 0) {
        return current;
      }
      const enabledPaths = new Set(
        (runtime?.extensions ?? []).filter((extension) => extension.enabled).map((extension) => extension.path),
      );
      let next: Set<string> | undefined;
      for (const path of current) {
        if (enabledPaths.has(path)) {
          next ??= new Set(current);
          next.delete(path);
        }
      }
      return next ?? current;
    });
  }, [runtime?.extensions]);

  // Detect active @ mention from the draft text
  const mentionMatch = useMemo(() => {
    if (suppressed) {
      return null;
    }
    return extractMentionQuery(composerDraft);
  }, [composerDraft, suppressed]);

  // Refresh (throttled) the moment a new "@" query starts, not on every keystroke of it.
  const hadMentionMatchRef = useRef(false);
  useEffect(() => {
    const hasMatch = Boolean(mentionMatch);
    if (hasMatch && !hadMentionMatchRef.current) {
      refreshFiles({ force: true });
    }
    hadMentionMatchRef.current = hasMatch;
  }, [mentionMatch, refreshFiles]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionMatch) {
      return [];
    }
    const lowerQuery = mentionMatch.query.toLowerCase();
    const extensionOptions = buildExtensionMentionOptions(runtime?.extensions ?? [], lowerQuery, pendingEnablePaths);
    const fileOptions = allFiles
      .filter((file) => file.toLowerCase().includes(lowerQuery))
      .slice(0, 10)
      .map<MentionOption>((filePath) => ({
        kind: "file",
        id: `file:${filePath}`,
        insertText: filePath,
        filePath,
      }));
    return [...extensionOptions, ...fileOptions];
  }, [allFiles, mentionMatch, pendingEnablePaths, runtime?.extensions]);

  // Show the menu whenever a query is active, even with zero candidates — an empty
  // dropdown with a "no matches" explanation beats silently showing nothing, which
  // previously left users unable to tell "no matches" apart from "@ mentions are
  // broken here" (e.g. in a non-git workspace before the listWorkspaceFiles fallback).
  const showMentionMenu = Boolean(mentionMatch);

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [mentionOptions.length]);

  const insertMentionAt = useCallback(
    (option: MentionOption, draft: string, match: { query: string; atIndex: number }) => {
      const before = draft.slice(0, match.atIndex);
      const afterCursor = draft.slice(match.atIndex + 1 + match.query.length);
      const inserted = `@${option.insertText} `;
      const newDraft = `${before}${inserted}${afterCursor}`;
      setComposerDraft(newDraft);
      setSuppressed(true);
      requestAnimationFrame(() => {
        const textarea = composerRef.current;
        if (textarea) {
          const newPos = before.length + inserted.length;
          textarea.setSelectionRange(newPos, newPos);
        }
      });
    },
    [composerRef, setComposerDraft],
  );

  const insertMention = useCallback(
    (option: MentionOption) => {
      if (!mentionMatch) {
        return;
      }
      insertMentionAt(option, composerDraft, mentionMatch);
    },
    [composerDraft, insertMentionAt, mentionMatch],
  );

  const enableMentionExtension = useCallback(
    (option: Extract<MentionOption, { kind: "extension" }>) => {
      if (option.enabled || !onEnableExtension) {
        insertMention(option);
        return;
      }
      if (option.enabling || !mentionMatch) {
        return;
      }

      const draftBeforeEnable = composerDraft;
      const mentionBeforeEnable = mentionMatch;
      setPendingEnablePaths((current) => {
        if (current.has(option.path)) {
          return current;
        }
        const next = new Set(current);
        next.add(option.path);
        return next;
      });
      void onEnableExtension(option.path)
        .then(() => {
          if (composerDraftRef.current !== draftBeforeEnable) {
            return;
          }
          insertMentionAt(option, draftBeforeEnable, mentionBeforeEnable);
        })
        .catch(() => undefined)
        .finally(() => {
          setPendingEnablePaths((current) => {
            if (!current.has(option.path)) {
              return current;
            }
            const next = new Set(current);
            next.delete(option.path);
            return next;
          });
        });
    },
    [composerDraft, insertMention, insertMentionAt, mentionMatch, onEnableExtension],
  );

  const handleMentionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showMentionMenu) {
        return false;
      }
      if (event.nativeEvent.isComposing) {
        return false;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) => nextMenuIndex(prev, 1, mentionOptions.length));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) => nextMenuIndex(prev, -1, mentionOptions.length));
        return true;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        // Only consume the key when there's an actual candidate to pick — in the empty
        // state (no matches) it must fall through so Enter still sends the message.
        const selected = mentionOptions[selectedIndex];
        if (!selected) {
          return false;
        }
        event.preventDefault();
        if (selected.kind === "extension" && !selected.enabled) {
          enableMentionExtension(selected);
        } else {
          insertMention(selected);
        }
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuppressed(true);
        return true;
      }

      return false;
    },
    [showMentionMenu, mentionOptions, selectedIndex, enableMentionExtension, insertMention],
  );

  return {
    showMentionMenu,
    mentionOptions,
    filesTruncated,
    selectedIndex,
    handleMentionKeyDown,
    insertMention,
    enableMentionExtension,
  };
}

function buildExtensionMentionOptions(
  extensions: readonly RuntimeExtensionRecord[],
  lowerQuery: string,
  pendingEnablePaths: ReadonlySet<string>,
): MentionOption[] {
  return extensions
    .map((extension) => ({
      extension,
      insertText: extensionMentionText(extension),
      description: describeExtension(extension),
      enabling: pendingEnablePaths.has(extension.path),
    }))
    .filter((option) => {
      if (!lowerQuery) {
        return true;
      }
      return [
        option.extension.displayName,
        option.insertText,
        option.extension.sourceInfo.source,
        extensionSourceSummary(option.extension),
      ].some((value) => value.toLowerCase().includes(lowerQuery));
    })
    .slice(0, 8)
    .map(({ extension, insertText, description, enabling }) => ({
      kind: "extension",
      id: `extension:${extension.path}`,
      displayName: extension.displayName,
      description,
      insertText,
      enabled: extension.enabled,
      enabling,
      path: extension.path,
    }));
}

function describeExtension(extension: RuntimeExtensionRecord): string {
  if (extension.description) {
    return extension.description;
  }

  const contributionParts = [
    extension.commands.length > 0 ? pluralizeContribution(extension.commands.length, "command") : undefined,
    extension.tools.length > 0 ? pluralizeContribution(extension.tools.length, "tool") : undefined,
  ].filter(Boolean);
  if (contributionParts.length > 0) {
    return contributionParts.join(" · ");
  }
  return extensionSourceSummary(extension);
}

function extensionMentionText(extension: RuntimeExtensionRecord): string {
  if (extension.sourceInfo.origin === "package") {
    return normalizeMentionText(packageMentionName(extension));
  }
  return normalizeMentionText(extension.displayName);
}

function packageMentionName(extension: RuntimeExtensionRecord): string {
  const source = extension.sourceInfo.source.trim();
  if (source.startsWith("npm:")) {
    return stripNpmPackageVersion(source.slice("npm:".length).trim());
  }

  return stripGitSuffix(lastResourceSegment(extension.sourceInfo.baseDir ?? source));
}

function stripNpmPackageVersion(value: string): string {
  if (value.startsWith("@")) {
    const scopeSeparator = value.indexOf("/", 1);
    if (scopeSeparator < 0) {
      return value;
    }
    const versionIndex = value.indexOf("@", scopeSeparator + 1);
    return versionIndex >= 0 ? value.slice(0, versionIndex) : value;
  }
  const versionIndex = value.indexOf("@");
  return versionIndex >= 0 ? value.slice(0, versionIndex) : value;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function lastResourceSegment(value: string): string {
  return value.split(/[/\\]+/).filter(Boolean).at(-1) ?? value;
}

function normalizeMentionText(value: string): string {
  return value.trim().replace(/^@+/, "").replace(/[/\\]+/g, "-").replace(/\s+/g, "-");
}

function pluralizeContribution(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}
