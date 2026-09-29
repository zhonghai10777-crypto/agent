import { stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { getDesktopState, startThreadFromSurface } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

const exists = (path: string) => stat(path).then(() => true, () => false);

// Removing a worktree deletes its directory. Under a running task that pulls
// the files away mid-run, and on Windows the directory cannot be deleted while
// the task's processes, or a terminal opened there, still use it.
test("refuses to remove a worktree while its task runs, then closes its terminals and removes it", async () => {
  test.setTimeout(90_000);
  const f = await launchWithCompactionFixture("worktree-removal", { git: true });
  try {
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    f.http.setNextReplyStream(["working ", "in the worktree"], { pauseAfter: 1 });
    await startThreadFromSurface(f.page, { environment: "worktree", prompt: "Work in a worktree" });
    const send = f.page.getByTestId("send");
    await expect(send).toHaveAttribute("aria-label", "Stop run", { timeout: 15_000 });

    const state = await getDesktopState(f.page);
    const worktreeWorkspace = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
    expect(worktreeWorkspace?.kind).toBe("worktree");
    const rootWorkspaceId = worktreeWorkspace?.kind === "worktree" ? worktreeWorkspace.rootWorkspaceId : undefined;
    const worktree = Object.values(state.worktreesByWorkspace)
      .flat()
      .find((entry) => entry.path === worktreeWorkspace?.path);
    if (!rootWorkspaceId || !worktree) {
      throw new Error("Expected the thread to run in a new worktree");
    }
    const remove = () =>
      f.page.evaluate(
        (input) => window.piApp!.removeWorktree(input).then((next) => next.lastError ?? null),
        { workspaceId: rootWorkspaceId, worktreeId: worktree.id },
      );

    expect(await remove()).toContain("still running");
    expect(await exists(worktree.path)).toBe(true);
    await expect(send).toHaveAttribute("aria-label", "Stop run");

    f.http.release();
    await expect(send).toHaveAttribute("aria-label", "Send message", { timeout: 15_000 });
    await f.page.getByRole("button", { name: "Toggle terminal" }).click();
    await expect(f.page.getByTestId("integrated-terminal").locator(".xterm")).toBeVisible();

    expect(await remove()).toBeNull();
    await expect.poll(() => exists(worktree.path)).toBe(false);
  } finally {
    f.http.release();
    await f.close();
  }
});
