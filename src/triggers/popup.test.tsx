import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { loadTheme } from "../theme";
import {
  displayTriggerCommand,
  moveTriggerSelection,
  sortTriggers,
  triggerActionForKey,
  triggerFields,
  triggerPopupGeometry,
  TriggersPopup,
  type TriggerSnapshot,
} from "./popup";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function trigger(
  id: string,
  createdAt: number,
  state: TriggerSnapshot["state"] = "idle",
): TriggerSnapshot {
  return {
    id,
    name: `Trigger ${id}`,
    state,
    target: { sessionId: "session-1", agentId: null, label: "main session" },
    executable: "/usr/bin/printf",
    args: ["--", id],
    cwd: "/tmp/project",
    mode: "repeat",
    restartDelayMs: 60_000,
    createdAt,
    expiresAt: createdAt + 60_000,
    nextRestartAt: null,
    fireCount: 2,
    maxFires: 8,
    pendingCount: 3,
    coalescedCount: 1,
    paused: state === "paused",
  };
}

async function renderPopup(
  width: number,
  height: number,
  triggers: TriggerSnapshot[],
  cursor: number,
) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <TriggersPopup
        theme={loadTheme("tokyonight")}
        triggers={triggers}
        cursor={cursor}
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

describe("external trigger popup helpers", () => {
  test("sorts stably by creation time and wraps selection", () => {
    const sameA = trigger("same-a", 20);
    const sameB = trigger("same-b", 20);
    expect(sortTriggers([sameA, trigger("first", 10), sameB]).map((item) => item.id))
      .toEqual(["first", "same-a", "same-b"]);
    expect(moveTriggerSelection(0, 3, -1)).toBe(2);
    expect(moveTriggerSelection(2, 3, 1)).toBe(0);
    expect(moveTriggerSelection(0, 0, 1)).toBe(0);
  });

  test("maps direct action keys and toggles pause/resume", () => {
    expect(triggerActionForKey({ name: "p" }, trigger("active", 1))).toBe("pause");
    expect(triggerActionForKey({ name: "p" }, trigger("paused", 1, "paused"))).toBe("resume");
    expect(triggerActionForKey({ name: "r" })).toBe("run");
    expect(triggerActionForKey({ name: "f" })).toBeNull();
    expect(triggerActionForKey({ name: "c" })).toBe("cancel");
    expect(triggerActionForKey({ name: "x" })).toBeNull();
  });

  test("redacts credential-shaped command arguments from display labels", () => {
    const value = trigger("secret", 1);
    value.args = ["--token", "hunter2", "--api-key=abc", "visible"];
    const displayed = displayTriggerCommand(value);
    expect(displayed).toContain("--token [redacted]");
    expect(displayed).toContain("--api-key=[redacted]");
    expect(displayed).not.toContain("hunter2");
    expect(displayed).not.toContain("abc");
  });

  test("lists the locked trigger contract fields", () => {
    expect(Object.fromEntries(triggerFields(trigger("fields", 1_700_000_000_000)))).toMatchObject({
      State: "idle",
      Target: "main session",
      Command: "/usr/bin/printf -- fields",
      Directory: "/tmp/project",
      Mode: "repeat · 60s",
      Runtime: "—",
      Runs: "2/8",
      Pending: "3 · 1 coalesced",
      Next: "—",
      Output: "—",
    });
  });
});

describe("external trigger popup layout", () => {
  test("renders list fields and action controls in a normal terminal", async () => {
    const frame = await renderPopup(100, 28, [trigger("alpha", 100)], 0);
    expect(frame).toContain("External triggers");
    expect(frame).toContain("Trigger alpha");
    expect(frame).toContain("main session");
    expect(frame).toContain("/usr/bin/printf -- alpha");
    expect(frame).toContain("p pause/resume");
    expect(frame).toContain("r run");
    expect(frame).not.toContain("f fire");
    expect(frame).toContain("c cancel");
    expect(frame).toContain("esc close");
  });

  test("uses the full compact surface without overflowing narrow or short terminals", async () => {
    expect(triggerPopupGeometry(42, 10)).toMatchObject({ compact: true, left: 1, top: 1, width: 40, height: 8 });
    const frame = await renderPopup(42, 10, [trigger("compact", 100)], 0);
    expect(frame).toContain("External triggers");
    expect(frame).toContain("Trigger compact");
    expect(frame.split("\n").every((line) => line.length <= 42)).toBe(true);
  });

  test("scrolls a long list to keep the selected trigger visible", async () => {
    const triggers = Array.from({ length: 20 }, (_, index) => trigger(`row-${index}`, index));
    const frame = await renderPopup(54, 14, triggers, 19);
    expect(frame).toContain("Trigger row-19");
    expect(frame).not.toContain("Trigger row-0 ");
  });
});
