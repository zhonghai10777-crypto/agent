import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir } from "../helpers/electron-app";

/**
 * The web-access screen changes shape per provider: DeepSeek borrows the model
 * credential and so must offer no key field, while Bocha/Tavily must still ask
 * for one. That branch lives in the renderer, so a unit test cannot catch a
 * regression where the key field disappears for every provider.
 */
test("web access settings bind the DeepSeek search key to the model provider", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("web-settings-");

  const harness = await launchDesktop(userDataDir, { testMode: "background" });

  try {
    const window = await harness.firstWindow();

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Web access", exact: true }).click();

    const provider = window.getByLabel("Search service");
    await expect(provider).toBeVisible();
    // Ships selected so a fresh install needs no second signup.
    await expect(provider).toHaveValue("deepseek");
    await expect(provider.locator("option")).toHaveText([
      "DeepSeek (uses your model key)",
      "Bocha (mainland China)",
      "Tavily",
      "Self-hosted SearXNG (intranet)",
    ]);

    // No key configured yet: the row must say where to add one rather than
    // offering a field that writes to the wrong place.
    await expect(window.getByText("No DeepSeek key yet — add one under Settings → Providers.")).toBeVisible();
    await expect(window.getByLabel("API key")).toHaveCount(0);

    // A provider with its own key still gets a key field.
    await provider.selectOption("bocha");
    await expect(window.getByLabel("API key")).toBeVisible();

    // SearXNG asks for an address instead.
    await provider.selectOption("searxng");
    await expect(window.getByLabel("SearXNG address")).toBeVisible();
    await expect(window.getByLabel("API key")).toHaveCount(0);

    // Back to DeepSeek: the field must not linger from the previous provider.
    await provider.selectOption("deepseek");
    await expect(window.getByLabel("API key")).toHaveCount(0);
    await expect(window.getByLabel("SearXNG address")).toHaveCount(0);
    await expect(window.getByText("No DeepSeek key yet — add one under Settings → Providers.")).toBeVisible();
  } finally {
    await harness.close();
  }
});
