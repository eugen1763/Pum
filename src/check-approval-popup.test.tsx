import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
  checkApprovalLayout,
  CheckApprovalPopup,
  invokeCheckApprovalDecision,
  type CheckApprovalDecision,
  type PendingCheckApproval,
} from "./check-approval-popup";
import { loadTheme } from "./theme";

const theme = loadTheme("tokyonight");
const request: PendingCheckApproval = {
  tool: "bash",
  summary: "Run the focused test suite",
  reason: "The command executes project code outside the verifier cache.",
  paths: ["src/check-approval-popup.tsx", "src/check-approval-popup.test.tsx"],
  preview: { kind: "command", text: "bun test src/check-approval-popup.test.tsx" },
  agentLabel: "main",
};

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

async function renderPopup(
  width: number,
  height: number,
  selectedDecision: CheckApprovalDecision = "allowOnce",
) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <CheckApprovalPopup
        theme={theme}
        request={request}
        selectedDecision={selectedDecision}
        terminalWidth={width}
        terminalHeight={height}
        onAllowOnce={() => {}}
        onAllowSession={() => {}}
        onAllowProject={() => {}}
        onDeny={() => {}}
      />
    </box>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return setup;
}

describe("check approval popup layout", () => {
  test("shows the complete request and all decisions in a normal terminal", async () => {
    const setup = await renderPopup(96, 28, "allowSession");
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Approval required");
    expect(frame).toContain("bash · main");
    expect(frame).toContain("Run the focused test suite");
    expect(frame).toContain("Reason: The command executes project code");
    expect(frame).toContain("src/check-approval-popup.tsx");
    expect(frame).toContain("Command");
    expect(frame).toContain("bun test src/check-approval-popup.test.tsx");
    expect(frame).toContain("Once");
    expect(frame).toContain("Session");
    expect(frame).toContain("Project");
    expect(frame).toContain("Deny");

    const selected = setup.captureSpans().lines
      .flatMap((line) => line.spans)
      .filter((span) => span.bg.equals(parseColor(theme.selectionBg)))
      .map((span) => span.text)
      .join("");
    expect(selected).toContain("Session");
  });

  test("uses stacked full labels in a narrow terminal without overflow", async () => {
    const setup = await renderPopup(38, 22, "allowProject");
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Allow once");
    expect(frame).toContain("Allow for session");
    expect(frame).toContain("Allow for project");
    expect(frame).toContain("esc deny");
    expect(frame.split("\n").every((line) => line.length <= 38)).toBe(true);
  });

  test("keeps identity, summary, decisions, and controls in a short terminal", async () => {
    const setup = await renderPopup(52, 10, "deny");
    const frame = setup.captureCharFrame();

    expect(checkApprovalLayout(52, 10)).toMatchObject({
      short: true,
      optionColumns: 2,
      popupHeight: 10,
      detailHeight: 1,
    });
    expect(frame).toContain("bash · main");
    expect(frame).toContain("Run the focused test suite");
    expect(frame).toContain("Allow once");
    expect(frame).toContain("Allow for session");
    expect(frame).toContain("Allow for project");
    expect(frame).toContain("Deny");
    expect(frame).toContain("enter choose");
    expect(frame.split("\n").every((line) => line.length <= 52)).toBe(true);
  });

  test("uses semantic warning, error, and popup colors", async () => {
    const setup = await renderPopup(80, 22, "deny");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const toolSpan = spans.find((span) => span.text.includes("bash"));
    const denySpan = spans.find((span) => span.text.includes("Deny"));

    expect(toolSpan?.fg.equals(parseColor(theme.warn))).toBe(true);
    expect(toolSpan?.bg.equals(parseColor(theme.popupBg))).toBe(true);
    expect(denySpan?.fg.equals(parseColor(theme.error))).toBe(true);
    expect(denySpan?.bg.equals(parseColor(theme.selectionBg))).toBe(true);
  });

  test("renders only caller-provided redacted preview text", async () => {
    const setup = await renderPopup(80, 22);
    const frame = setup.captureCharFrame();

    expect(frame).toContain(request.preview.text);
    expect(frame).not.toContain("api-key-secret-value");
  });
});

describe("check approval popup callbacks", () => {
  test("routes each decision to one explicit callback", () => {
    const calls: string[] = [];
    const callbacks = {
      onAllowOnce: () => calls.push("once"),
      onAllowSession: () => calls.push("session"),
      onAllowProject: () => calls.push("project"),
      onDeny: () => calls.push("deny"),
    };

    invokeCheckApprovalDecision("allowOnce", callbacks);
    invokeCheckApprovalDecision("allowSession", callbacks);
    invokeCheckApprovalDecision("allowProject", callbacks);
    invokeCheckApprovalDecision("deny", callbacks);

    expect(calls).toEqual(["once", "session", "project", "deny"]);
  });
});
