import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { loadTheme } from "../src/theme";
import {
  displayShellCommand,
  moveProcessSelection,
  processTabForKey,
  ProcessesPopup,
  shellFields,
  sortShells,
  type ManagedShellSnapshot,
} from "../src/processes-popup";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function shell(
  id: string,
  createdAt: number,
  state: ManagedShellSnapshot["state"] = "running",
): ManagedShellSnapshot {
  return {
    id,
    name: `Shell ${id}`,
    state,
    owner: { sessionId: "session-1", agentId: null, label: "main session" },
    executable: "/usr/bin/server",
    args: ["--port", "8080"],
    cwd: "/tmp/project",
    createdAt,
    startedAt: createdAt + 10,
    finishedAt: null,
    exitCode: null,
    signal: null,
    ready: true,
    readyAt: createdAt + 20,
    output: { path: "/tmp/shell-output", bytes: 42, truncated: false, exists: true },
  };
}

async function renderPopup(width: number, height: number, shells: ManagedShellSnapshot[]) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <ProcessesPopup
        theme={loadTheme("tokyonight")}
        tab="shells"
        triggers={[]}
        shells={shells}
        triggerCursor={0}
        shellCursor={0}
        shellTail="ready\nGET /health 200\n"
        terminalWidth={width}
        terminalHeight={height}
      />
    </box>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return setup.captureCharFrame();
}

describe("Processes popup helpers", () => {
  test("switches tabs and wraps shell selection", () => {
    expect(processTabForKey({ name: "right" }, "triggers")).toBe("shells");
    expect(processTabForKey({ name: "left" }, "shells")).toBe("triggers");
    expect(processTabForKey({ name: "tab" }, "shells")).toBe("triggers");
    expect(processTabForKey({ name: "x" }, "shells")).toBeNull();
    expect(moveProcessSelection(0, 3, -1)).toBe(2);
    expect(moveProcessSelection(2, 3, 1)).toBe(0);
  });

  test("sorts shells stably and exposes shell metadata", () => {
    const sameA = shell("same-a", 20);
    const sameB = shell("same-b", 20);
    expect(sortShells([sameA, shell("first", 10), sameB]).map((item) => item.id))
      .toEqual(["first", "same-a", "same-b"]);
    expect(displayShellCommand(shell("command", 1))).toBe("/usr/bin/server --port 8080");
    expect(Object.fromEntries(shellFields(shell("fields", 1_700_000_000_000)))).toMatchObject({
      State: "running",
      Owner: "main session",
      Command: "/usr/bin/server --port 8080",
      Directory: "/tmp/project",
      Ready: expect.any(String),
      Output: "42 bytes",
    });
  });
});

describe("Processes popup shell tab", () => {
  test("renders shell metadata, output tail, and kill control", async () => {
    const frame = await renderPopup(100, 30, [shell("api", 100)]);
    expect(frame).toContain("Processes");
    expect(frame).toContain("Triggers");
    expect(frame).toContain("Shells");
    expect(frame).toContain("Shell api");
    expect(frame).toContain("main session");
    expect(frame).toContain("/usr/bin/server --port 8080");
    expect(frame).toContain("GET /health 200");
    expect(frame).toContain("k kill");
    expect(frame).toContain("esc close");
  });

  test("uses a compact surface without terminal overflow", async () => {
    const frame = await renderPopup(42, 10, [shell("compact", 100)]);
    expect(frame).toContain("Processes");
    expect(frame).toContain("Shell compact");
    expect(frame.split("\n").every((line) => line.length <= 42)).toBe(true);
  });
});
