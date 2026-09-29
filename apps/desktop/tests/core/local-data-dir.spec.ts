import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addLinkedWorktree,
  addWorkspaceViaIpc,
  getDesktopState,
  isPathWithin,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  pathExists,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

// On Windows userData defaults to %APPDATA%, the roaming profile that domain
// accounts sync at every logon and logoff. Worktrees (whole checkouts) and the
// library index belong under %LOCALAPPDATA%. Resolution follows the two
// variables, so pointing them at a fixture exercises the Windows layout anywhere.
test("keeps worktrees and the library index out of the Windows roaming profile", async () => {
  test.setTimeout(90_000);
  const base = await makeUserDataDir("pi-gui-profile-roots-");
  const roaming = join(base, "Roaming");
  const local = join(base, "Local");
  const userDataDir = join(roaming, "Agent");
  const localDataDir = join(local, "Agent");
  const workspacePath = await makeGitWorkspace("local-data-dir");
  // What an earlier version left in the roaming profile.
  await mkdir(join(userDataDir, "library-index"), { recursive: true });
  await writeFile(join(userDataDir, "library-index", "index.json"), "{}");
  const legacyOrphan = join(userDataDir, "worktrees", "repo", "legacy-orphan");
  await addLinkedWorktree(workspacePath, legacyOrphan, "pi/legacy-orphan");

  // No workspaces at startup, so the orphan's repository is unknown and the GC may collect it.
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [],
    testMode: "background",
    envOverrides: { APPDATA: roaming, LOCALAPPDATA: local },
  });
  try {
    const window = await harness.firstWindow();
    // Worktrees made before the move stay usable, and orphans there are still collected.
    await expect.poll(() => pathExists(legacyOrphan)).toBe(false);
    expect(await readFile(join(localDataDir, "library-index", "index.json"), "utf8")).toBe("{}");
    expect(await pathExists(join(userDataDir, "library-index"))).toBe(false);

    await addWorkspaceViaIpc(window, workspacePath);
    const rootWorkspace = await waitForWorkspaceByPath(window, workspacePath);
    await window.getByRole("button", { name: `Workspace actions for ${rootWorkspace.name}` }).click();
    await window.getByRole("button", { name: "Create permanent worktree" }).click();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.kind;
      })
      .toBe("worktree");
    const state = await getDesktopState(window);
    const created = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)!.path;
    expect(isPathWithin(await realpath(join(localDataDir, "worktrees")), created)).toBe(true);
  } finally {
    await harness.close();
    await rm(base, { recursive: true, force: true });
    await rm(dirname(workspacePath), { recursive: true, force: true });
  }
});
