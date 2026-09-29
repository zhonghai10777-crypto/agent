import { expect, test } from "@playwright/test";
import { buildTerminalEnv, terminalShellLaunch } from "../../electron/terminal-env";

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

test("Git Bash starts as a login shell in the terminal's folder; other shells start as before", () => {
  const loginBash = { args: ["--login", "-i"], env: { CHERE_INVOKING: "1" } };
  expect(terminalShellLaunch("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toEqual(loginBash);
  expect(terminalShellLaunch("D:\\工具\\Git\\bin\\BASH.EXE", "win32")).toEqual(loginBash);
  const plain = { args: [], env: {} };
  expect(terminalShellLaunch("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32")).toEqual(plain);
  expect(terminalShellLaunch("/bin/zsh", "darwin")).toEqual(plain);
  expect(terminalShellLaunch("/bin/bash", "linux")).toEqual(plain);
});
