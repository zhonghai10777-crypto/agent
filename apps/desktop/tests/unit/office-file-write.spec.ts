import * as fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  atomicOfficeWrite,
  createExcelDocument,
  createWordDocument,
  type OfficeFileIO,
  type OfficeFormat,
} from "../../electron/office-runtime";

const ioError = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
const noLinks: OfficeFileIO = { ...fs, link: async () => { throw ioError("ENOTSUP"); } };
const documentBytes = (format: OfficeFormat) => format === "docx"
  ? createWordDocument("报告", ["内容"])
  : createExcelDocument("数据", [["项目", "金额"], ["电费", 10]]);

for (const format of ["docx", "xlsx"] as const) {
  test(`${format} publishes through a native link with a bounded temp name`, async ({}, testInfo) => {
    await fs.mkdir(testInfo.outputDir, { recursive: true });
    const output = testInfo.outputPath(`${"报".repeat(70)}${"x".repeat(30)}.${format}`);
    const buffer = await documentBytes(format);
    await atomicOfficeWrite(output, buffer, format);
    expect(new Uint8Array(await fs.readFile(output))).toEqual(buffer);
    expect((await fs.readdir(testInfo.outputDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test(`${format} saves without hard-link support`, async ({}, testInfo) => {
    await fs.mkdir(testInfo.outputDir, { recursive: true });
    const buffer = await documentBytes(format);
    for (const code of ["ENOTSUP", "EPERM", "ENOSYS", "EXDEV"]) {
      const output = testInfo.outputPath(`${code}.${format}`);
      await atomicOfficeWrite(output, buffer, format, { ...fs, link: async () => { throw ioError(code); } });
      expect(new Uint8Array(await fs.readFile(output))).toEqual(buffer);
    }
  });
}

for (const fallback of [false, true]) {
  test(`a competing output is preserved with fallback=${fallback}`, async ({}, testInfo) => {
    await fs.mkdir(testInfo.outputDir, { recursive: true });
    const output = testInfo.outputPath("report.docx");
    const sentinel = Buffer.from("created by another process");
    await expect(atomicOfficeWrite(output, createWordDocument(), "docx", {
      ...fs,
      async link(from, to) {
        await fs.writeFile(to, sentinel, { flag: "wx" });
        if (fallback) throw ioError("ENOTSUP");
        await fs.link(from, to);
      },
    })).rejects.toThrow(/避免覆盖/);
    expect(await fs.readFile(output)).toEqual(sentinel);
  });
}

for (const fault of ["writeFile", "sync", "close"] as const) {
  test(`fallback ${fault} failure removes only its incomplete file`, async ({}, testInfo) => {
    await fs.mkdir(testInfo.outputDir, { recursive: true });
    const output = testInfo.outputPath("incomplete.docx");
    const io: OfficeFileIO = {
      ...noLinks,
      async open(file, flags, mode) {
        const handle = await fs.open(file, flags, mode);
        if (file !== output) return handle;
        return new Proxy(handle, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              if (property === fault) {
                if (fault === "writeFile") await target.writeFile("partial bytes");
                if (fault === "close") await target.close();
                throw ioError("EIO");
              }
              return value.apply(target, args);
            };
          },
        });
      },
    };
    await expect(atomicOfficeWrite(output, createWordDocument(), "docx", io)).rejects.toMatchObject({ code: "EIO" });
    await expect(fs.readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(testInfo.outputDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
}

test("failure cleanup preserves a different file moved into the output path", async ({}, testInfo) => {
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  const output = testInfo.outputPath("report.docx");
  const sentinel = "someone else's file";
  await expect(atomicOfficeWrite(output, createWordDocument(), "docx", {
    ...noLinks,
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (file !== output) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") return async () => {
            await target.writeFile("partial");
            await fs.rename(output, testInfo.outputPath("displaced-partial.docx"));
            await fs.writeFile(output, sentinel, { flag: "wx" });
            throw ioError("EIO");
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  })).rejects.toMatchObject({ code: "EIO" });
  expect(await fs.readFile(output, "utf8")).toBe(sentinel);
});

test("successful publication remains successful when temp cleanup fails", async ({}, testInfo) => {
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  const output = testInfo.outputPath("saved.docx");
  const buffer = createWordDocument("Saved");
  await atomicOfficeWrite(output, buffer, "docx", {
    ...fs,
    unlink: async () => { throw ioError("EPERM"); },
  });
  expect(new Uint8Array(await fs.readFile(output))).toEqual(buffer);
  expect((await fs.readdir(testInfo.outputDir)).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
});

test("an actual link I/O failure does not silently fall back to another write", async ({}, testInfo) => {
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  const output = testInfo.outputPath("failed.docx");
  await expect(atomicOfficeWrite(output, createWordDocument(), "docx", {
    ...fs, link: async () => { throw ioError("EIO"); },
  })).rejects.toMatchObject({ code: "EIO" });
  await expect(fs.readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
