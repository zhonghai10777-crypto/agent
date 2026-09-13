import { expect, test } from "@playwright/test";
import { createNamedThread, getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace, pasteTinyPng } from "../helpers/electron-app";

test("composer rejects excessive paste/drop before reading files and retains the existing draft and screenshot", async ({}, info) => {
  const harness = await launchDesktop(await makeUserDataDir("image-budget-"), { initialWorkspaces: [await makeWorkspace("image-budget")], scrubProviderEnv: true, testMode: "background" });
  try {
    const page = await harness.firstWindow();
    await createNamedThread(page, "Image budget proof");
    await pasteTinyPng(page, "retained.png");
    await page.getByTestId("composer").fill("Keep my draft");
    for (const kind of ["count", "bytes"] as const) {
      await page.getByTestId("composer").evaluate((target, kind) => {
        const transfer = new DataTransfer();
        for (let i = 0; i < (kind === "count" ? 8 : 1); i++) {
          const file = new File(["synthetic"], `synthetic-${i}.png`, { type: "image/png" });
          Object.defineProperty(file, "size", { value: kind === "bytes" ? 11 * 1024 * 1024 : 8 });
          file.arrayBuffer = async () => { throw new Error("BUG: budget preflight read image bytes"); };
          transfer.items.add(file);
        }
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, kind);
      await expect(page.getByText(kind === "count" ? /at most 8 images/ : /Each image must be at most/)).toBeVisible();
      await expect(page.getByTestId("composer")).toHaveValue("Keep my draft");
      await expect(page.locator(".composer-attachment")).toHaveCount(1);
      expect((await getDesktopState(page)).composerAttachments[0]?.name).toBe("retained.png");
    }
    await page.screenshot({ path: info.outputPath("image-budget-draft-retained.png") });
  } finally { await harness.close(); }
});
