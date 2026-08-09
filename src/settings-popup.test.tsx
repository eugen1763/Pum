import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
  filterModels,
  filterSettingsRows,
  isModelSearchShortcut,
  isSettingsSearchShortcut,
  moveSettingSelection,
  SettingsPopup,
  SETTINGS_ROWS,
  type SettingRowId,
} from "./settings-popup";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const values = Object.fromEntries(
  SETTINGS_ROWS.map((row) => [row.id, row.id === "workingRuleAnimation" ? "‹ coordinated ›" : "‹ on ›"]),
) as Record<SettingRowId, string>;

describe("settings search and navigation", () => {
  test("filters labels, categories, and useful keywords", () => {
    expect(filterSettingsRows("working").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("safety").map((row) => row.id)).toEqual(["checkMode", "checkModel"]);
    expect(filterSettingsRows("reasoning visible").map((row) => row.id)).toEqual(["showThinking"]);
    expect(filterSettingsRows("progress detailed").map((row) => row.id)).toEqual(["explanationStrength"]);
    expect(filterSettingsRows("fail-closed bash edit").map((row) => row.id)).toEqual(["checkMode"]);
    expect(SETTINGS_ROWS.every((row) => row.description.length > 20)).toBe(true);
  });

  test("filters model and check-model rows across provider and model metadata", () => {
    const models = [
      { provider: "openai", id: "gpt-5", name: "GPT Five" },
      { provider: "anthropic", id: "claude", name: "Claude" },
    ] as any;
    const providerName = (id: string) => id === "openai" ? "OpenAI Platform" : "Anthropic";
    expect(filterModels(models, "platform five", providerName).map((model) => model.id)).toEqual(["gpt-5"]);
    expect(filterModels(models, "CLAUDE", providerName).map((model) => model.id)).toEqual(["claude"]);
    expect(filterModels(models, "missing", providerName)).toEqual([]);
  });

  test("moves only through filtered rows and wraps", () => {
    const rows = filterSettingsRows("check");
    expect(moveSettingSelection(rows, "checkMode", 1)).toBe("checkModel");
    expect(moveSettingSelection(rows, "checkModel", 1)).toBe("checkMode");
    expect(moveSettingSelection([], "checkMode", 1)).toBeNull();
  });

  test("uses slash to focus search only from a highlighted row", () => {
    const slash = { name: "/", sequence: "/" };
    expect(isSettingsSearchShortcut(slash, false)).toBe(true);
    expect(isSettingsSearchShortcut(slash, true)).toBe(false);
    expect(isSettingsSearchShortcut({ ...slash, ctrl: true }, false)).toBe(false);
    expect(isModelSearchShortcut(slash, false)).toBe(true);
    expect(isModelSearchShortcut(slash, true)).toBe(false);
  });
});

describe("settings popup layout", () => {
  test("keeps search, categories, values, and controls visible in a narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 48, height: 18 });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <box style={{ width: 48, height: 18 }}>
        <SettingsPopup
          theme={loadTheme("tokyonight")}
          page="main"
          rows={SETTINGS_ROWS}
          selectedId="workingRuleAnimation"
          values={values}
          query=""
          searchFocused={false}
          terminalWidth={48}
          terminalHeight={18}
          models={[]}
          onSearchChange={() => {}}
          onSelectModel={() => {}}
          onSelectCheckModel={() => {}}
        />
      </box>,
    );
    await setup.renderOnce();
    await setup.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Search");
    expect(frame).toContain("Appearance");
    expect(frame).toContain("Working animation");
    expect(frame).toContain("coordinated");
    expect(frame).toContain("header and input rules");
    expect(frame).toContain("animate while an agent works");
    expect(frame).toContain("/ search");
  });

  test("uses popup backgrounds for model and check-model rows", async () => {
    const theme = loadTheme("tokyonight");
    const models = [
      { id: "model-a", provider: "provider-a" },
      { id: "model-b", provider: "provider-b" },
    ] as any;

    for (const page of ["models", "checkModels"] as const) {
      const setup = await createTestRenderer({ width: 60, height: 18 });
      destroy = () => setup.renderer.destroy();
      createRoot(setup.renderer).render(
        <box style={{ width: 60, height: 18 }}>
          <SettingsPopup
            theme={theme}
            page={page}
            rows={SETTINGS_ROWS}
            selectedId="model"
            values={values}
            query=""
            searchFocused={false}
            terminalWidth={60}
            terminalHeight={18}
            models={models}
            onSearchChange={() => {}}
            onSelectModel={() => {}}
            onSelectCheckModel={() => {}}
          />
        </box>,
      );
      await setup.renderOnce();
      await setup.flush();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup.renderOnce();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const selectedSpan = spans.find((span) => span.text.includes("model-a"));
      const normalSpan = spans.find((span) => span.text.includes("model-b"));

      expect(selectedSpan?.bg.equals(parseColor(theme.selectionBg))).toBe(true);
      expect(normalSpan?.bg.equals(parseColor(theme.popupBg))).toBe(true);
      setup.renderer.destroy();
      destroy = undefined;
    }
  });
});
