import { describe, expect, test } from "bun:test";
import { readClipboardText } from "../src/text-paste";

describe("clipboard text paste", () => {
  test("uses the native Windows clipboard without a command", async () => {
    let commandCalled = false;
    const text = await readClipboardText({
      platform: "win32",
      env: {},
      nativeClipboard: { getText: async () => "mock clipboard text" },
      runner: async () => { commandCalled = true; return ""; },
    });
    expect(text).toBe("mock clipboard text");
    expect(commandCalled).toBe(false);
  });

  test("uses direct PowerShell arguments after native Windows failure", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const text = await readClipboardText({
      platform: "win32",
      env: {},
      nativeClipboard: { getText: async () => { throw new Error("busy"); } },
      runner: async (command, args) => {
        calls.push({ command, args });
        return "mock fallback text";
      },
    });
    expect(text).toBe("mock fallback text");
    expect(calls).toEqual([{
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Clipboard -Raw))",
      ],
    }]);
  });

  test("does not read the host clipboard for a remote session", async () => {
    let nativeCalled = false;
    await expect(readClipboardText({
      platform: "win32",
      env: { SSH_CONNECTION: "mock" },
      nativeClipboard: { getText: async () => { nativeCalled = true; return "hidden"; } },
    })).rejects.toThrow("remote session");
    expect(nativeCalled).toBe(false);
  });
});
