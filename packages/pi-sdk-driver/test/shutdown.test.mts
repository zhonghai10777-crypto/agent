import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIsPidAlive } from "../dist/session-lease.js";
import { makeSupervisedSession, waitUntil } from "./supervised-session-fixture.mts";

test("shutdown kills the process tree of a bash tool call that is still running", async () => {
  const pidDir = await mkdtemp(join(tmpdir(), "shutdown-pid-"));
  const pidFile = join(pidDir, "pid");
  // `exec` keeps the shell's pid for sleep, so the recorded pid is the
  // long-running process itself - the one that used to outlive the app.
  const fixture = await makeSupervisedSession("bash", [{ kind: "tool", name: "bash", arguments: { command: `echo $$ > '${pidFile}' && exec sleep 120` } }]);
  try {
    const completion = fixture.supervisor.sendUserMessage(fixture.ref, { text: "run it" }).catch(() => {});
    await waitUntil(() => existsSync(pidFile));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await waitUntil(() => defaultIsPidAlive(pid));

    await fixture.supervisor.shutdown();

    await waitUntil(() => !defaultIsPidAlive(pid), 3000);
    await completion;
  } finally {
    await fixture.cleanup();
    await rm(pidDir, { recursive: true, force: true });
  }
});
