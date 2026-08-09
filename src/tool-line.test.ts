import { describe, expect, test } from "bun:test";
import { editCounts, toolArg } from "./tool-line";

describe("apply_patch tool metadata", () => {
  test("shows compact single-file and multi-file arguments", () => {
    expect(toolArg("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src\\one.ts\n@@\n-a\n+b\n*** End Patch",
    }, "/repo")).toBe("src/one.ts");

    expect(toolArg("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch",
    }, "/repo")).toBe("old.ts → new.ts");

    expect(toolArg("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: one.ts\n+x\n*** Delete File: two.ts\n*** End Patch",
    }, "/repo")).toBe("2 files · one.ts");
  });

  test("summarizes questionnaire arguments without exposing every option", () => {
    expect(toolArg("questionnaire", {
      questions: [
        { id: "scope", label: "Scope", prompt: "Choose scope", options: [] },
        { id: "format", prompt: "Choose format", options: [] },
      ],
    }, "/repo")).toBe("2 questions · Scope");
  });

  test("counts unified patch additions and removals", () => {
    expect(editCounts({
      details: {
        patch: "--- a.ts\n+++ a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
      },
    })).toBe("+2 −1");
  });
});
