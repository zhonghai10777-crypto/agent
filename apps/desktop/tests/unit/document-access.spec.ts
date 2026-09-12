import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { authorizeDocumentPath, isPathWithinRoot } from "../../electron/document-access";

test("realpath scope allows internal files and explicit external attachments, rejects escapes", async ({}, info) => {
  const root = info.outputPath("root");
  const external = info.outputPath("root-sibling");
  await mkdir(root, { recursive: true });
  await mkdir(external);
  const file = path.join(external, "secret.txt");
  const valid = path.join(root, "..notes.txt");
  await writeFile(file, "synthetic external data");
  await writeFile(valid, "legitimate filename");
  const scope = { workspaceRoots: [root], allowedFiles: [] };
  expect(await authorizeDocumentPath(valid, scope)).toBe(valid);
  await expect(authorizeDocumentPath(file, scope)).rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
  await expect(authorizeDocumentPath(path.join(root, "..", "root-sibling", "secret.txt"), scope))
    .rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
  expect(await authorizeDocumentPath(file, { ...scope, allowedFiles: [file] })).toBe(file);
  // On Windows this creates an actual junction; on this Mac it proves a POSIX symlink.
  await symlink(external, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(authorizeDocumentPath(path.join(root, "escape", "secret.txt"), scope))
    .rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
  await symlink(root, info.outputPath("authorized-root"), process.platform === "win32" ? "junction" : "dir");
  expect(await authorizeDocumentPath(valid, { workspaceRoots: [info.outputPath("authorized-root")], allowedFiles: [] })).toBe(valid);
  await expect(authorizeDocumentPath(info.outputPath("missing"), scope)).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  await expect(authorizeDocumentPath(valid, { workspaceRoots: [info.outputPath("missing")], allowedFiles: [] }))
    .rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
});

test("Windows lexical boundaries distinguish drives, UNC shares, parent traversal and dotted names", () => {
  expect(isPathWithinRoot("C:\\work\\..notes.txt", "C:\\work", path.win32)).toBe(true);
  expect(isPathWithinRoot("C:\\work-sibling\\file.txt", "C:\\work", path.win32)).toBe(false);
  expect(isPathWithinRoot("D:\\work\\file.txt", "C:\\work", path.win32)).toBe(false);
  expect(isPathWithinRoot("C:\\work\\..\\file.txt", "C:\\work", path.win32)).toBe(false);
  expect(isPathWithinRoot("\\\\server\\share2\\file.txt", "\\\\server\\share", path.win32)).toBe(false);
  expect(isPathWithinRoot("\\\\server\\share\\dir\\file.txt", "\\\\server\\share", path.win32)).toBe(true);
});
