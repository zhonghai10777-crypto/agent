import { expect, test } from "@playwright/test";
import { buildTerminalEnv } from "../../electron/terminal-env";

test("the integrated terminal drops variables the app set only for the agent's shell tools", () => {
  const source = { PATH: "/bin", PYTHONIOENCODING: "utf-8", TERMINFO: "/x", HOME: "/home/me" };
  expect(buildTerminalEnv(["PYTHONIOENCODING"], source)).toEqual({
    PATH: "/bin",
    HOME: "/home/me",
    TERM: "xterm-256color",
  });
  // Nothing omitted: a user's own PYTHONIOENCODING reaches their shell untouched.
  expect(buildTerminalEnv([], source).PYTHONIOENCODING).toBe("utf-8");
});
