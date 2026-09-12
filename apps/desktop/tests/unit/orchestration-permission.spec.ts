import { expect, test } from "@playwright/test";
import type { AppStoreInternals } from "../../electron/app-store-internals";
import { assertModelDelegationAllowed } from "../../electron/permission-mode";
import { assertRuntimeCapability } from "../../electron/runtime-mode";

const caller = { workspaceId: "workspace", sessionId: "caller" };

for (const scenario of ["plan", "unknown", "light"] as const) {
  test(`model dispatch guard denies ${scenario} before touching the target or driver`, () => {
    let touchedTarget = false;
    const store = {
      initialize: async () => {},
      sessionFromState: () => scenario === "unknown" ? undefined : { title: "Caller" },
      sessionPermissionMode: () => scenario === "plan" ? "plan" : "auto",
      assertCapability: () => assertRuntimeCapability(scenario === "light" ? "light" : "agent", "childAgents"),
      get state() { touchedTarget = true; throw new Error("Target must not be resolved"); },
      get driver() { touchedTarget = true; throw new Error("Driver must not run"); },
    } as unknown as AppStoreInternals;
    for (const tool of ["send_message_to_thread", "create_child_thread"]) {
      expect(() => assertModelDelegationAllowed(store, caller, tool))
        .toThrow(scenario === "plan" ? /Read-only/ : scenario === "unknown" ? /calling session/ : /light mode/);
    }
    expect(touchedTarget).toBe(false);
  });
}
