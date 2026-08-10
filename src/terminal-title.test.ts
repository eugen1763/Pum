import { describe, expect, test } from "bun:test";
import { formatTerminalTitle, TerminalTitleController } from "./terminal-title";

describe("terminal title formatting", () => {
  test("formats idle and working titles without an empty subagent segment", () => {
    expect(formatTerminalTitle({ working: false, activeSubagentCount: 0 })).toBe("Pum · idle");
    expect(formatTerminalTitle({ working: true, activeSubagentCount: 0 })).toBe("Pum · working");
  });

  test("uses singular and plural subagent wording", () => {
    expect(formatTerminalTitle({ working: true, activeSubagentCount: 1 }))
      .toBe("Pum · working · 1 subagent");
    expect(formatTerminalTitle({ working: true, activeSubagentCount: 2 }))
      .toBe("Pum · working · 2 subagents");
  });

  test("normalizes invalid counts", () => {
    expect(formatTerminalTitle({ working: false, activeSubagentCount: -2 })).toBe("Pum · idle");
    expect(formatTerminalTitle({ working: false, activeSubagentCount: 2.9 }))
      .toBe("Pum · idle · 2 subagents");
  });
});

describe("terminal title updates", () => {
  test("deduplicates unchanged titles and writes lifecycle transitions", () => {
    const writes: string[] = [];
    const title = new TerminalTitleController((value) => writes.push(value));

    expect(title.update({ working: false, activeSubagentCount: 0 })).toBe(true);
    expect(title.update({ working: false, activeSubagentCount: 0 })).toBe(false);
    expect(title.update({ working: true, activeSubagentCount: 0 })).toBe(true);
    expect(title.update({ working: true, activeSubagentCount: 1 })).toBe(true);
    expect(title.update({ working: true, activeSubagentCount: 1 })).toBe(false);
    expect(title.update({ working: false, activeSubagentCount: 0 })).toBe(true);

    expect(writes).toEqual([
      "Pum · idle",
      "Pum · working",
      "Pum · working · 1 subagent",
      "Pum · idle",
    ]);
  });

  test("clears once after a title was written", () => {
    const writes: string[] = [];
    const title = new TerminalTitleController((value) => writes.push(value));

    expect(title.clear()).toBe(false);
    title.update({ working: false, activeSubagentCount: 0 });
    expect(title.clear()).toBe(true);
    expect(title.clear()).toBe(false);
    expect(writes).toEqual(["Pum · idle", ""]);
  });

  test("keeps title failures outside application control flow", () => {
    let attempts = 0;
    const title = new TerminalTitleController(() => {
      attempts += 1;
      throw new Error("unsupported terminal");
    });

    expect(title.update({ working: true, activeSubagentCount: 0 })).toBe(false);
    expect(title.update({ working: true, activeSubagentCount: 0 })).toBe(false);
    expect(attempts).toBe(2);
  });
});
