import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { listWorkspaceFiles, readWorkspaceFile } from "../../electron/app-store-files";

const execFileAsync = promisify(execFile);

test("lists non-ASCII and space-bearing paths in a git workspace exactly as they are on disk", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-workspace-files-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: workspacePath });
    await mkdir(join(workspacePath, "资料"));
    // One tracked, one untracked: `git ls-files` quotes both kinds as
    // "\345\217\221..." octal escapes unless it is asked for NUL-separated output.
    await writeFile(join(workspacePath, "发电报告.docx"), "report");
    await writeFile(join(workspacePath, "资料", "年度 计划.txt"), "plan");
    await writeFile(join(workspacePath, "plain.txt"), "plain");
    await execFileAsync("git", ["add", "发电报告.docx", "plain.txt"], { cwd: workspacePath });

    const result = await listWorkspaceFiles(workspacePath, { force: true });

    expect(result.files).toEqual(["plain.txt", "发电报告.docx", "资料/年度 计划.txt"].sort());
    expect(result.truncated).toBe(false);
    // A listed path must be usable as-is by the file preview behind @mentions.
    expect((await readWorkspaceFile(workspacePath, "资料/年度 计划.txt")).content).toBe("plan");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
