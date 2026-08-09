import { describe, expect, test } from "bun:test";
import {
  QuestionnaireManager,
  questionnaireDetail,
  type QuestionnaireQuestion,
} from "./questionnaire";

const questions: QuestionnaireQuestion[] = [
  {
    id: "scope",
    label: "Scope",
    prompt: "Choose a scope",
    options: [
      { value: "small", label: "Small" },
      { value: "large", label: "Large", description: "Use all modules" },
    ],
  },
  {
    id: "format",
    prompt: "Choose a format",
    options: [{ value: "json", label: "JSON" }],
  },
];

function mountedManager() {
  const manager = new QuestionnaireManager();
  const unsubscribe = manager.subscribe(() => {});
  return { manager, unsubscribe };
}

describe("questionnaire controller", () => {
  test("collects one selected answer per question in question order", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "main", name: "main" }, questions);

    manager.moveOption(1);
    expect(manager.select()).toBe("selected");
    expect(manager.select()).toBe("selected");
    expect(manager.select()).toBe("submitted");

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [
        { questionId: "scope", value: "large", label: "Large", custom: false },
        { questionId: "format", value: "json", label: "JSON", custom: false },
      ],
    });
    unsubscribe();
  });

  test("keeps a custom draft outside the request until explicit submission", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "worker", name: "worker" }, [questions[1]!]);

    manager.moveOption(1);
    expect(manager.select()).toBe("custom");
    expect(manager.current()?.answers.size).toBe(0);
    expect(JSON.stringify(manager.current())).not.toContain("private token");
    expect(manager.submitCustom(" private token ")).toBe(true);
    expect(manager.select()).toBe("submitted");

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [{
        questionId: "format",
        value: "private token",
        label: "private token",
        custom: true,
      }],
    });
    unsubscribe();
  });

  test("cancels the active request and advances a queued request", async () => {
    const { manager, unsubscribe } = mountedManager();
    const first = manager.request({ id: "main", name: "main" }, [questions[0]!]);
    const second = manager.request({ id: "child", name: "child" }, [questions[1]!]);

    expect(manager.current()?.requester.id).toBe("main");
    manager.cancel();
    await expect(first).resolves.toEqual({ cancelled: true, answers: [] });
    expect(manager.current()?.requester.id).toBe("child");
    manager.cancel();
    await expect(second).resolves.toEqual({ cancelled: true, answers: [] });
    unsubscribe();
  });

  test("registers a sequential model tool and returns JSON answers", async () => {
    const { manager, unsubscribe } = mountedManager();
    let tool: any;
    manager.registerTool({ registerTool(value: any) { tool = value; } } as any, { id: "main", name: "main" });

    expect(tool.name).toBe("questionnaire");
    expect(tool.executionMode).toBe("sequential");
    const execution = tool.execute("call-1", { questions: [questions[0]!] });
    manager.select();
    manager.select();
    const result = await execution;

    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    expect(questionnaireDetail(result)).toBe("1 answer");
    unsubscribe();
  });

  test("rejects duplicate question identifiers", async () => {
    const { manager, unsubscribe } = mountedManager();
    await expect(manager.request(
      { id: "main", name: "main" },
      [questions[0]!, { ...questions[1]!, id: "scope" }],
    )).rejects.toThrow("Duplicate questionnaire question id");
    unsubscribe();
  });
});
