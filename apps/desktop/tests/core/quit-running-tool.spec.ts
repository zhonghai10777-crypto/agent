import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { defaultIsPidAlive } from "../../../../packages/pi-sdk-driver/src/session-lease";
import { startThreadFromSurface } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

// pi's bash tool runs each command in its own detached process group. Before
// quit shut sessions down, a command still running when the user quit kept
// running forever, reparented away from the app.
test("quitting while a bash tool call is still running kills the command's process", async () => {
  test.skip(process.platform === "win32", "Uses a POSIX shell command to record its pid.");
  const f = await launchWithCompactionFixture("quit-tool");
  const pidFile = join(f.workspacePath, "long-command.pid");
  const readPid = async () => Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || 0;
  let pid = 0;
  try {
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    // `exec` keeps the shell's pid for sleep, so the recorded pid is the
    // long-running process itself.
    f.http.setNextToolCall("bash", { command: `echo $$ > '${pidFile}' && exec sleep 300` });

    await startThreadFromSurface(f.page, { prompt: "Run the long command" });

    await expect.poll(readPid, { timeout: 15_000 }).toBeGreaterThan(0);
    pid = await readPid();
    expect(defaultIsPidAlive(pid)).toBe(true);
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");

    await f.harness.close();

    await expect.poll(() => defaultIsPidAlive(pid), { timeout: 10_000 }).toBe(false);
  } finally {
    await f.close();
    if (pid > 0 && defaultIsPidAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});
