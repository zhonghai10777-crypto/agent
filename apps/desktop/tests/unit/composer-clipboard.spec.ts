import { expect, test } from "@playwright/test";
import { extractFilesFromDataTransfer, extractImageFilesFromClipboardData } from "../../src/composer-attachments";

test("clipboard file views with different timestamps produce one image", () => {
  const file = new File(["synthetic PNG"], "image.png", { type: "image/png", lastModified: 1 });
  const itemFile = new File(["synthetic PNG"], "image.png", { type: "image/png", lastModified: 2 });
  const transfer = {
    files: [file],
    items: [{ kind: "file", getAsFile: () => itemFile }],
  } as unknown as DataTransfer;
  expect(extractImageFilesFromClipboardData(transfer)).toEqual([file]);
  expect(extractFilesFromDataTransfer(transfer)).toEqual([file]);
});

test("item-only clipboard payloads retain all images and omit plain text", () => {
  const png = new File(["synthetic PNG"], "first.png", { type: "image/png" });
  const jpeg = new File(["synthetic JPEG"], "second.jpg", { type: "image/jpeg" });
  const text = new File(["synthetic text"], "note.txt", { type: "text/plain" });
  const transfer = {
    files: [],
    items: [png, jpeg, text].map((file) => ({ kind: "file", getAsFile: () => file })),
  } as unknown as DataTransfer;
  expect(extractImageFilesFromClipboardData(transfer)).toEqual([png, jpeg]);
  expect(extractFilesFromDataTransfer(transfer)).toEqual([png, jpeg, text]);
});
