import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  captureClipboardImage,
  cleanupPendingImages,
  clipboardBackend,
} from "./image-paste";

afterEach(() => cleanupPendingImages());

describe("clipboard platform selection", () => {
  test("selects Windows PowerShell independently of display variables", () => {
    expect(clipboardBackend("win32", {})).toBe("windows");
    expect(clipboardBackend("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(clipboardBackend("linux", { DISPLAY: ":0" })).toBe("x11");
    expect(clipboardBackend("linux", {})).toBeNull();
  });

  test("captures Windows clipboard bytes as a temporary PNG", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const image = await captureClipboardImage({
      platform: "win32",
      env: {},
      nativeClipboard: null,
      runner: async (command, args) => {
        calls.push({ command, args });
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("powershell.exe");
    expect(calls[0]!.args).toContain("-STA");
    expect(calls[0]!.args).toContain("-NoProfile");
    expect(image.mimeType).toBe("image/png");
    expect(image.path.endsWith(".png")).toBe(true);
    expect(readFileSync(image.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("prefers the native Windows clipboard adapter", async () => {
    let powerShellCalled = false;
    const image = await captureClipboardImage({
      platform: "win32",
      env: {},
      nativeClipboard: {
        hasImage: () => true,
        getImageBinary: async () => [0x89, 0x50, 0x4e, 0x47],
      },
      runner: async () => {
        powerShellCalled = true;
        return Buffer.alloc(0);
      },
    });
    expect(powerShellCalled).toBe(false);
    expect(readFileSync(image.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
