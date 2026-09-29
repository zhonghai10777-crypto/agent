import { expect, test } from "@playwright/test";
import { gitArgs } from "../../electron/git-exec";

test("the app's git calls lift Windows' path length limit and change nothing elsewhere", () => {
  expect(gitArgs(["worktree", "add", "x"], "win32")).toEqual(["-c", "core.longpaths=true", "worktree", "add", "x"]);
  expect(gitArgs(["status"], "darwin")).toEqual(["status"]);
  expect(gitArgs(["status"], "linux")).toEqual(["status"]);
});
