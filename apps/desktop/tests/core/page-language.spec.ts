import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

// Chromium picks the fallback font for Han characters by the page language; a
// page marked English on Windows can draw Chinese with a Japanese font.
test("the page language follows the interface language, with Chinese fonts in the UI and code stacks", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("page-language");
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspacePath], testMode: "background" });
  try {
    const window = await harness.firstWindow();
    const lang = () => window.evaluate(() => document.documentElement.lang);
    await expect.poll(lang).toBe("en");

    await window.evaluate(() => window.piApp!.setLocale("zh-CN"));
    await expect.poll(lang).toBe("zh-CN");

    // UI text and code alike carry the Chinese fallbacks.
    const fontFamilies = await window.evaluate(() => [
      getComputedStyle(document.body).fontFamily,
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
    ]);
    for (const fontFamily of fontFamilies) {
      expect(fontFamily).toContain("Microsoft YaHei UI");
    }
  } finally {
    await harness.close();
  }
});
