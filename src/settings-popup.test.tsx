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
  settingsPopupLayout,
  SETTINGS_ROWS,
  type SettingRowId,
} from "./settings-popup";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const values = Object.fromEntries(
  SETTINGS_ROWS.map((row) => [row.id, row.id === "workingRuleAnimation" ? "‹ Sparkle trail ›" : "‹ on ›"]),
) as Record<SettingRowId, string>;

describe("settings search and navigation", () => {
  test("filters labels, categories, and useful keywords", () => {
    expect(filterSettingsRows("working").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("comet pair").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("electric spark").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("constellation").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("random constellation").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("energy transfer").map((row) => row.id)).toEqual(["workingRuleAnimation"]);
    expect(filterSettingsRows("transcript verbose").map((row) => row.id)).toEqual(["outputMode"]);
    expect(filterSettingsRows("safety").map((row) => row.id)).toEqual([
      "checkMode", "sandboxMode", "checkModel", "checkPaths",
    ]);
    expect(filterSettingsRows("reasoning visible").map((row) => row.id)).toEqual(["showThinking"]);
    expect(filterSettingsRows("progress detailed").map((row) => row.id)).toEqual(["explanationStrength"]);
    expect(filterSettingsRows("parallel capacity").map((row) => row.id)).toEqual(["maxActiveSubagents"]);
    expect(filterSettingsRows("verify tools bash").map((row) => row.id)).toEqual(["checkMode"]);
    expect(filterSettingsRows("external trigger process").map((row) => row.id)).toContain("checkMode");
    expect(SETTINGS_ROWS.find((row) => row.id === "outputMode")?.label).toBe("Transcript detail");
    expect(SETTINGS_ROWS.find((row) => row.id === "explanationStrength")?.label).toBe("Progress narration");
    expect(SETTINGS_ROWS.find((row) => row.id === "jspace")?.label).toBe("J-Space");
    expect(SETTINGS_ROWS.find((row) => row.id === "jspace")?.description).toContain("off by default");
    expect(SETTINGS_ROWS.find((row) => row.id === "showThinking")?.label).toBe("Thinking traces");
    expect(SETTINGS_ROWS.find((row) => row.id === "checkModel")?.description)
      .toContain("complete Check mode proposals");
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
    expect(moveSettingSelection(rows, "checkModel", 1)).toBe("checkPaths");
    expect(moveSettingSelection(rows, "checkPaths", 1)).toBe("checkMode");
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
  test("scales monotonically while reserving content, footer, and shadow rows", () => {
    for (const page of ["main", "models", "checkModels"] as const) {
      const heights = [8, 24, 60];
      const layouts = heights.map((height) => settingsPopupLayout(80, height, page));

      expect(layouts.map((layout) => layout.popupHeight)).toEqual(
        [...layouts].map((layout) => layout.popupHeight).sort((a, b) => a - b),
      );
      expect(layouts.map((layout) => layout.listHeight)).toEqual(
        [...layouts].map((layout) => layout.listHeight).sort((a, b) => a - b),
      );
      expect(layouts[2]!.listHeight).toBeGreaterThan(layouts[1]!.listHeight);
      expect(layouts[1]!.listHeight).toBeGreaterThan(layouts[0]!.listHeight);

      for (const [index, layout] of layouts.entries()) {
        expect(layout.top).toBeGreaterThanOrEqual(0);
        expect(layout.top + layout.popupHeight).toBeLessThan(heights[index]!);
        expect(layout.searchHeight).toBe(1);
        expect(layout.listHeight).toBeGreaterThanOrEqual(1);
        expect(layout.footerHeight).toBe(1);
      }
    }

    expect(settingsPopupLayout(80, 100, "main").popupHeight).toBe(32);
    expect(settingsPopupLayout(80, 100, "models").popupHeight).toBe(28);
  });

  test("keeps the selected row, footer, and semantic shadow visible at responsive heights", async () => {
    const theme = loadTheme("tokyonight");

    for (const height of [8, 24, 60]) {
      const setup = await createTestRenderer({ width: 80, height });
      destroy = () => setup.renderer.destroy();
      createRoot(setup.renderer).render(
        <box style={{ width: 80, height, backgroundColor: theme.bg }}>
          <SettingsPopup
            theme={theme}
            page="main"
            rows={SETTINGS_ROWS}
            selectedId="checkPaths"
            values={values}
            query=""
            searchFocused={false}
            terminalWidth={80}
            terminalHeight={height}
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup.renderOnce();
      await setup.flush();

      const frame = setup.captureCharFrame();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      expect(frame).toContain("Allowed paths");
      expect(frame).toContain("/ search");
      expect(spans.some((span) => span.fg.equals(parseColor(theme.popupShadow)))).toBe(true);
      expect(frame.split("\n").slice(0, -1)).toHaveLength(height);

      setup.renderer.destroy();
      destroy = undefined;
    }
  });

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
    expect(frame).toContain("Sparkle trail");
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
