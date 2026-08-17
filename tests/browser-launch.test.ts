import { describe, expect, test } from "bun:test";
import {
  browserLaunchCommand,
  credentialFreeHttpUrl,
  launchBrowserUrl,
} from "../src/browser-launch";

describe("browser URL launcher", () => {
  test("launches a valid URL with direct argv", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const launched = await launchBrowserUrl("https://login.example.test/oauth?state=abc", {
      platform: "linux",
      spawn: async (executable, args) => { calls.push({ executable, args }); },
    });

    expect(launched).toBe(true);
    expect(calls).toEqual([{
      executable: "xdg-open",
      args: ["https://login.example.test/oauth?state=abc"],
    }]);
  });

  test("rejects non-http and credential-bearing URLs", async () => {
    const calls: string[] = [];
    const spawn = async (executable: string) => { calls.push(executable); };

    expect(credentialFreeHttpUrl("https://user:secret@example.test/login")).toBeNull();
    expect(await launchBrowserUrl("file:///tmp/login", { platform: "linux", spawn })).toBe(false);
    expect(await launchBrowserUrl("https://user@example.test/login", { platform: "linux", spawn })).toBe(false);
    expect(await launchBrowserUrl("not a URL", { platform: "linux", spawn })).toBe(false);
    expect(calls).toEqual([]);
  });

  test("returns false when the platform launcher fails", async () => {
    expect(await launchBrowserUrl("https://example.test/login", {
      platform: "linux",
      spawn: async () => { throw new Error("xdg-open unavailable"); },
    })).toBe(false);
  });

  test("builds platform-specific executable and argument arrays", () => {
    const url = "https://example.test/login";
    expect(browserLaunchCommand("win32", url)).toEqual({
      executable: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(browserLaunchCommand("darwin", url)).toEqual({ executable: "open", args: [url] });
    expect(browserLaunchCommand("linux", url)).toEqual({ executable: "xdg-open", args: [url] });
    expect(browserLaunchCommand("freebsd", url)).toBeNull();
  });
});
