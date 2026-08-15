import { describe, expect, test } from "bun:test";
import { AFK_RULE_STATES, afkLabelColor, modeLineLabels, type AfkRuleState } from "./mode-line";
import {
  GOAL_LABEL_RIGHT_PADDING,
  MIN_RULE_COLUMNS,
  goalLabel,
  goalLabelColor,
} from "./goal-line";
import { createGoal, type GoalRecord, type GoalState } from "./goal";
import { statusTextWidth } from "./status-metadata";
import { PRESET_NAMES, loadTheme } from "./theme";

const theme = loadTheme("tokyonight");

function goal(text = "ship the release", state: GoalState = "active"): GoalRecord {
  return { ...createGoal(text, 10, 1, "goal-1"), state };
}

const on: AfkRuleState = { state: "on", instructions: "prefer safe options" };

const texts = (input: {
  goal?: GoalRecord | null;
  afk?: AfkRuleState | null;
  ruleWidth: number;
}) =>
  modeLineLabels({
    goal: input.goal ?? null,
    afk: input.afk ?? null,
    ruleWidth: input.ruleWidth,
    theme,
  }).map((label) => label.text);

const totalWidth = (input: { goal: GoalRecord | null; afk: AfkRuleState | null; ruleWidth: number }) =>
  modeLineLabels({ ...input, theme }).reduce((sum, label) => sum + label.width, 0);

describe("mode line labels", () => {
  test("a goal alone is exactly the label the goal rule already painted", () => {
    for (let ruleWidth = 0; ruleWidth <= 200; ruleWidth++) {
      const expected = goalLabel(goal(), ruleWidth);
      const labels = modeLineLabels({ goal: goal(), afk: null, ruleWidth, theme });
      expect(labels.map((label) => label.text)).toEqual(expected ? [expected.text] : []);
      if (expected) expect(labels[0]!.color).toBe(goalLabelColor(theme, "active"));
    }
  });

  test("AFK and the goal share one row, AFK first, each with its own colour", () => {
    const labels = modeLineLabels({ goal: goal(), afk: on, ruleWidth: 200, theme });
    expect(labels).toHaveLength(2);
    expect(labels[0]!.text).toBe("AFK · on · prefer safe options  ");
    expect(labels[1]!.text).toBe("GOAL · active · ship the release  ");
    expect(labels[0]!.color).toBe(afkLabelColor(theme, "on"));
    expect(labels[1]!.color).toBe(goalLabelColor(theme, "active"));
    expect(labels[0]!.color).not.toBe(labels[1]!.color);
  });

  test("every label reports its own rendered width", () => {
    for (const label of modeLineLabels({ goal: goal(), afk: on, ruleWidth: 200, theme })) {
      expect(label.width).toBe(statusTextWidth(label.text));
    }
  });

  test("the last label ends with exactly two columns of right padding", () => {
    for (const ruleWidth of [200, 100, 56, 28]) {
      const labels = modeLineLabels({ goal: goal(), afk: on, ruleWidth, theme });
      const last = labels.at(-1)!;
      expect(last.text.endsWith(" ".repeat(GOAL_LABEL_RIGHT_PADDING))).toBe(true);
      expect(last.text.at(-GOAL_LABEL_RIGHT_PADDING - 1)).not.toBe(" ");
    }
  });

  test("the labels always leave the sweep some rule to run on", () => {
    for (let ruleWidth = 0; ruleWidth <= 200; ruleWidth++) {
      for (const afk of [null, on, { state: "answering" } as const]) {
        for (const text of ["ship it", "x".repeat(400), "模型".repeat(50)]) {
          const width = totalWidth({ goal: goal(text), afk, ruleWidth });
          if (width > 0) expect(width).toBeLessThanOrEqual(ruleWidth - MIN_RULE_COLUMNS);
        }
      }
    }
  });

  test("a goal alone never takes more than half the rule", () => {
    for (const ruleWidth of [24, 40, 80, 120, 200]) {
      const width = totalWidth({ goal: goal("x".repeat(400)), afk: null, ruleWidth });
      expect(width).toBeLessThanOrEqual(Math.floor(ruleWidth / 2));
    }
  });
});

describe("mode line narrow-terminal priority", () => {
  const shrink = (ruleWidth: number) => texts({ goal: goal(), afk: on, ruleWidth });

  test("a wide rule shows both states, the instructions, and the goal text", () => {
    expect(shrink(200)).toEqual([
      "AFK · on · prefer safe options  ",
      "GOAL · active · ship the release  ",
    ]);
  });

  test("the goal text goes first", () => {
    expect(shrink(100)).toEqual(["AFK · on · prefer safe options  ", "GOAL · active  "]);
  });

  test("the AFK instruction preview goes next", () => {
    expect(shrink(56)).toEqual(["AFK · on  ", "GOAL · active  "]);
  });

  test("the goal goes next, and takes the preview with it", () => {
    expect(shrink(28)).toEqual(["AFK · on  "]);
  });

  test("nothing is painted only when no useful label fits", () => {
    expect(shrink(12)).toEqual([]);
    expect(shrink(0)).toEqual([]);
    expect(texts({ ruleWidth: 200 })).toEqual([]);
    expect(texts({ afk: { state: "answering" }, ruleWidth: 16 })).toEqual([]);
  });

  test("each step keeps AFK and its state, whatever else it drops", () => {
    for (let ruleWidth = 12; ruleWidth <= 200; ruleWidth++) {
      const labels = shrink(ruleWidth);
      if (labels.length === 0) continue;
      expect(labels[0]!.startsWith("AFK · on")).toBe(true);
    }
  });

  test("both states share the rule rather than one losing to half-rule budget", () => {
    // 34 columns is under twice the two states, so a strict half would drop one.
    expect(shrink(34)).toEqual(["AFK · on  ", "GOAL · active  "]);
  });

  test("a rule wide enough for the goal state never hides it for the preview", () => {
    for (let ruleWidth = 12; ruleWidth <= 200; ruleWidth++) {
      const labels = shrink(ruleWidth);
      const showsPreview = labels[0]?.startsWith("AFK · on · ") ?? false;
      if (showsPreview) expect(labels.length).toBe(2);
    }
  });
});

describe("mode line label text", () => {
  test("collapses multi-line AFK instructions to one line", () => {
    const labels = texts({
      afk: { state: "on", instructions: "first line\n\n  second line" },
      ruleWidth: 200,
    });
    expect(labels[0]).not.toContain("\n");
    expect(labels[0]).toContain("first line second line");
  });

  test("truncates instructions by terminal columns without splitting a grapheme", () => {
    const labels = modeLineLabels({
      goal: null,
      afk: { state: "on", instructions: "模型模型模型模型模型模型" },
      ruleWidth: 40,
      theme,
    });
    expect(labels[0]!.width).toBe(statusTextWidth(labels[0]!.text));
    expect(labels[0]!.text).toContain("…");
    const combining = texts({
      afk: { state: "on", instructions: "éclair éclair éclair éclair" },
      ruleWidth: 40,
    });
    expect(combining[0]).not.toContain("́…");
  });

  test("no instructions means no preview, whatever the width", () => {
    expect(texts({ afk: { state: "on" }, ruleWidth: 200 })).toEqual(["AFK · on  "]);
    expect(texts({ afk: { state: "answering", instructions: "" }, ruleWidth: 200 })).toEqual([
      "AFK · answering  ",
    ]);
  });

  test("every AFK state names itself", () => {
    for (const state of AFK_RULE_STATES) {
      expect(texts({ afk: { state }, ruleWidth: 200 })[0]).toBe(`AFK · ${state}  `);
    }
  });

  test("every goal state still names itself beside AFK", () => {
    for (const state of ["active", "stopped", "blocked", "completed", "failed"] as const) {
      const labels = texts({ goal: goal("ship it", state), afk: { state: "on" }, ruleWidth: 200 });
      expect(labels[1]).toContain(`· ${state} ·`);
    }
  });
});

describe("AFK label colour", () => {
  test("uses a semantic token per state in every preset", () => {
    for (const name of PRESET_NAMES) {
      const preset = loadTheme(name);
      expect(afkLabelColor(preset, "on")).toBe(preset.agentMessage);
      expect(afkLabelColor(preset, "answering")).toBe(preset.statsRunning);
    }
  });

  test("no preset paints AFK in the rule colour it sits on", () => {
    for (const name of PRESET_NAMES) {
      const preset = loadTheme(name);
      for (const state of AFK_RULE_STATES) {
        expect(afkLabelColor(preset, state)).not.toBe(preset.border);
        expect(afkLabelColor(preset, state)).not.toBe(preset.dim);
      }
    }
  });
});
