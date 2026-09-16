import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  writeTextFile,
} from "../helpers/electron-app";

test("picks up a file created after launch once a new @ query starts", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("mention-refresh-workspace");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Mention refresh test");

    // Created after the app (and its one-shot mount-time file fetch) already started.
    await writeTextFile(join(workspacePath, "just-created-file.md"), "# fresh\n");

    const composer = window.getByTestId("composer");
    await composer.click();
    // The first "@" query in this composer instance is the refresh trigger under test —
    // it must not be limited to whatever listWorkspaceFiles returned at mount.
    await composer.pressSequentially("@just-created");

    const mentionMenu = window.getByTestId("mention-menu");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__filename")).toContainText("just-created-file.md");
  } finally {
    await harness.close();
  }
});

test("falls back to a directory walk for @ mentions in a non-git workspace", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  // makeWorkspace() deliberately skips git init — this is the same shape as the
  // built-in personal workspace, which `git ls-files` always fails against.
  const workspacePath = await makeWorkspace("mention-non-git-workspace");
  await writeTextFile(join(workspacePath, "plain-notes.md"), "notes");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Non-git mention test");

    const composer = window.getByTestId("composer");
    const mentionMenu = window.getByTestId("mention-menu");

    // A real match: the walk fallback must discover files on disk even without git.
    await composer.click();
    await composer.pressSequentially("@plain-notes");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__filename")).toContainText("plain-notes.md");

    // A guaranteed non-match: the menu must explain "no matches" instead of vanishing
    // silently, which is what made this bug invisible in the first place.
    await composer.fill("");
    await composer.click();
    await composer.pressSequentially("@definitely-not-a-real-file-zzz");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__empty")).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__filename")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
