import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stat, utimes } from "node:fs/promises";
import { DEFAULT_LEASE_TTL_MS, LEASE_REFRESH_INTERVAL_MS, sessionLeasePath } from "../dist/session-lease.js";
import { makeSupervisedSession } from "./supervised-session-fixture.mts";

test("a bound session keeps its lease fresh, and stops once the runtime is released", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const fixture = await makeSupervisedSession("lease", []);
  try {
    const sessionFile = await fixture.supervisor.getSessionFilePath(fixture.ref);
    assert.ok(sessionFile);
    const leasePath = sessionLeasePath(sessionFile);
    // Age the lease past the TTL, as it would be after the runtime had been
    // bound that long: another host would now treat it as dead.
    const stale = new Date(Date.now() - DEFAULT_LEASE_TTL_MS * 2);
    await utimes(leasePath, stale, stale);

    mock.timers.tick(LEASE_REFRESH_INTERVAL_MS);
    const deadline = Date.now() + 5_000;
    while ((await stat(leasePath)).mtimeMs < Date.now() - LEASE_REFRESH_INTERVAL_MS) {
      assert.ok(Date.now() < deadline, "the lease mtime was never refreshed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await fixture.supervisor.shutdown();
    assert.equal(existsSync(leasePath), false, "releasing the runtime removes the lease");
    mock.timers.tick(LEASE_REFRESH_INTERVAL_MS * 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(leasePath), false, "no refresh recreates a released lease");
  } finally {
    mock.timers.reset();
    await fixture.cleanup();
  }
});

