import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir } from "../helpers/electron-app";

/**
 * The web-access screen changes shape per provider: everything except SearXNG
 * asks for a key, and DeepSeek additionally reports whether it could borrow one
 * from the model provider. That branch lives in the renderer, so a unit test
 * cannot catch a regression where the key field disappears for a provider.
 */
test("web access settings offer a DeepSeek search key field and report the borrowed one", async () => {
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

    // Nothing to borrow on a fresh profile: the field is offered anyway, and the
    // status says the borrow found nothing rather than sending the user away.
    const apiKey = window.getByLabel("API key");
    await expect(apiKey).toBeVisible();
    await expect(window.getByText("No DeepSeek key found — paste one here.")).toBeVisible();

    // A provider with its own key still gets a key field, and no borrow status:
    // only DeepSeek has a model credential to fall back on.
    await provider.selectOption("bocha");
    await expect(apiKey).toBeVisible();
    await expect(window.getByText("No DeepSeek key found — paste one here.")).toHaveCount(0);

    // SearXNG asks for an address instead.
    await provider.selectOption("searxng");
    await expect(window.getByLabel("SearXNG address")).toBeVisible();
    await expect(apiKey).toHaveCount(0);

    // Back to DeepSeek: the address field must not linger from SearXNG.
    await provider.selectOption("deepseek");
    await expect(window.getByLabel("SearXNG address")).toHaveCount(0);
    await expect(apiKey).toBeVisible();

    // A typed key is what search will use, so the "nothing found" status clears.
    await apiKey.fill("sk-typed-into-web-access");
    await apiKey.blur();
    await expect(window.getByText("No DeepSeek key found — paste one here.")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
