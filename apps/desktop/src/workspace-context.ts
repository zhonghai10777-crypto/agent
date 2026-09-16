import {
  getSelectedWorkspace,
  type DesktopAppState,
  type WorkspaceRecord,
  type WorktreeRecord,
} from "./desktop-state";
import type { Translator } from "./i18n";
import { resolveRepoWorkspaceId } from "./workspace-roots";

/**
 * The literal name the main process seeds the built-in personal workspace with
 * (electron/app-store.ts). It's written once at first launch and never migrated
 * on disk, so `workspaceDisplayName` below localizes it at render time instead —
 * this constant is the anchor that lets us tell "still the untouched default"
 * apart from "the user renamed it to this exact string, which we must respect".
 */
export const DEFAULT_PERSONAL_WORKSPACE_NAME = "个人空间";

/**
 * Renders a workspace's display name, localizing the built-in personal
 * workspace's name if it's still at its untouched default. A user-renamed
 * personal workspace (or any non-personal workspace) is returned as-is.
 */
export function workspaceDisplayName(workspace: Pick<WorkspaceRecord, "kind" | "name">, t: Translator): string {
  if (workspace.kind === "personal" && workspace.name === DEFAULT_PERSONAL_WORKSPACE_NAME) {
    return t("workspace.personal");
  }
  return workspace.name;
}

export interface WorkspaceContext {
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly activeWorktrees: readonly WorktreeRecord[];
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
}

export function deriveWorkspaceContext(snapshot: DesktopAppState | null | undefined): WorkspaceContext {
  if (!snapshot) {
    return {
      selectedWorkspace: undefined,
      activeWorktrees: [],
      linkedWorktreeByWorkspaceId: new Map(),
      rootWorkspace: undefined,
      rootWorkspaceOptions: [],
      visibleWorkspaces: [],
    };
  }

  const selectedWorkspace = getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0];
  const workspacesById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace] as const));
  const primaryWorkspaces = snapshot.workspaces.filter(
    (workspace) => workspace.kind === "primary" || workspace.kind === "personal",
  );
  const orphanWorkspaces = snapshot.workspaces.filter(
    (workspace) => workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );
  const visibleWorkspaces =
    primaryWorkspaces.length > 0 ? [...primaryWorkspaces, ...orphanWorkspaces] : snapshot.workspaces;
  const linkedWorktreeByWorkspaceId = new Map(
    Object.values(snapshot.worktreesByWorkspace)
      .flat()
      .filter((worktree) => Boolean(worktree.linkedWorkspaceId))
      .map((worktree) => [worktree.linkedWorkspaceId as string, worktree] as const),
  );
  const rootWorkspaceId = resolveRepoWorkspaceId<WorkspaceRecord>(snapshot.workspaces, selectedWorkspace?.id);
  const rootWorkspace =
    (rootWorkspaceId ? snapshot.workspaces.find((workspace) => workspace.id === rootWorkspaceId) : undefined) ??
    selectedWorkspace;
  const rootWorkspaceOptions = [...new Set(
    snapshot.workspaces.map((workspace) => resolveRepoWorkspaceId<WorkspaceRecord>(snapshot.workspaces, workspace.id) ?? workspace.id),
  )]
    .map((workspaceId) => snapshot.workspaces.find((workspace) => workspace.id === workspaceId))
    .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));

  return {
    selectedWorkspace,
    activeWorktrees: rootWorkspace ? snapshot.worktreesByWorkspace[rootWorkspace.id] ?? [] : [],
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
  };
}
