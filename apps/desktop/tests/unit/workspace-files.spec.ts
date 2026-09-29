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

test("previews Windows-encoded text instead of calling it binary or garbling it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-preview-encodings-"));
  try {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("PowerShell 输出\r\n", "utf16le")]);
    await writeFile(join(workspace, "ps-redirect.txt"), utf16);
    // "中文" in GBK, as legacy Windows tools and much domestic material write it.
    await writeFile(join(workspace, "legacy.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    // A UTF-8 file larger than the preview limit, cut mid-character by it.
    await writeFile(join(workspace, "large.txt"), `a${"中".repeat(100_000)}`);
    await writeFile(join(workspace, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x00]));

    const redirect = await readWorkspaceFile(workspace, "ps-redirect.txt");
    expect(redirect.binary).toBe(false);
    expect(redirect.content).toBe("PowerShell 输出\r\n");
    expect((await readWorkspaceFile(workspace, "legacy.txt")).content).toBe("中文");
    const large = await readWorkspaceFile(workspace, "large.txt");
    expect(large.truncated).toBe(true);
    expect(large.content).toMatch(/^a中+$/u);
    expect((await readWorkspaceFile(workspace, "blob.bin")).binary).toBe(true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
