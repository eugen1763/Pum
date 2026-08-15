import { describe, expect, test } from "bun:test";
import {
  QuestionnaireManager,
  questionnaireDetail,
  type QuestionnaireAnswer,
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

const scopeAnswer: QuestionnaireAnswer = {
  questionId: "scope",
  value: "large",
  label: "Large",
  custom: false,
};
const formatAnswer: QuestionnaireAnswer = {
  questionId: "format",
  value: "json",
  label: "JSON",
  custom: false,
};

describe("questionnaire programmatic completion", () => {
  test("resolves the pending call with answers in question order", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "main", name: "main" }, questions);
    const id = manager.current()!.id;

    // Supplied out of order to prove the reply follows the questions, not the caller.
    expect(manager.completeCurrent(id, {
      cancelled: false,
      answers: [formatAnswer, scopeAnswer],
    })).toBe(true);

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [scopeAnswer, formatAnswer],
    });
    expect(manager.current()).toBeUndefined();
    unsubscribe();
  });

  test("accepts a custom answer that matches no option", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "main", name: "main" }, [questions[1]!]);

    expect(manager.completeCurrent(manager.current()!.id, {
      cancelled: false,
      answers: [{ questionId: "format", value: "yaml", label: "YAML", custom: true }],
    })).toBe(true);

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [{ questionId: "format", value: "yaml", label: "YAML", custom: true }],
    });
    unsubscribe();
  });

  test("cancels the request the controller named, not whichever is shown later", async () => {
    const { manager, unsubscribe } = mountedManager();
    const first = manager.request({ id: "main", name: "main" }, [questions[0]!]);
    const second = manager.request({ id: "child", name: "child" }, [questions[0]!]);
    const id = manager.current()!.id;

    expect(manager.completeCurrent(id, { cancelled: true, answers: [] })).toBe(true);
    await expect(first).resolves.toEqual({ cancelled: true, answers: [] });

    // The queue advanced, so the same id must not reach the promoted request.
    expect(manager.completeCurrent(id, { cancelled: true, answers: [] })).toBe(false);
    expect(manager.current()?.requester.id).toBe("child");
    manager.cancel();
    await expect(second).resolves.toEqual({ cancelled: true, answers: [] });
    unsubscribe();
  });

  test("discards partial popup selections instead of merging them", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "main", name: "main" }, questions);

    manager.moveOption(1);
    expect(manager.select()).toBe("selected");
    expect(manager.current()?.answers.size).toBe(1);

    expect(manager.completeCurrent(manager.current()!.id, {
      cancelled: false,
      answers: [
        { questionId: "scope", value: "small", label: "Small", custom: false },
        formatAnswer,
      ],
    })).toBe(true);

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [
        { questionId: "scope", value: "small", label: "Small", custom: false },
        formatAnswer,
      ],
    });
    unsubscribe();
  });

  test("rejects results that do not match the asked questions", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "main", name: "main" }, questions);
    const id = manager.current()!.id;

    const rejected: Array<[string, unknown]> = [
      ["missing an answer", { cancelled: false, answers: [scopeAnswer] }],
      ["an extra answer", { cancelled: false, answers: [scopeAnswer, formatAnswer, formatAnswer] }],
      ["a duplicate id", { cancelled: false, answers: [scopeAnswer, scopeAnswer] }],
      ["an unknown id", {
        cancelled: false,
        answers: [scopeAnswer, { ...formatAnswer, questionId: "nope" }],
      }],
      ["an unoffered value", {
        cancelled: false,
        answers: [{ ...scopeAnswer, value: "huge" }, formatAnswer],
      }],
      ["a relabelled option", {
        cancelled: false,
        answers: [{ ...scopeAnswer, label: "Huge" }, formatAnswer],
      }],
      ["a blank custom answer", {
        cancelled: false,
        answers: [{ ...scopeAnswer, value: " ", label: " ", custom: true }, formatAnswer],
      }],
      ["a non-string value", {
        cancelled: false,
        answers: [{ ...scopeAnswer, value: 1 }, formatAnswer],
      }],
      ["a non-boolean custom flag", {
        cancelled: false,
        answers: [{ ...scopeAnswer, custom: "yes" }, formatAnswer],
      }],
      ["a cancellation carrying answers", { cancelled: true, answers: [scopeAnswer, formatAnswer] }],
      ["a non-boolean cancelled flag", { cancelled: "no", answers: [scopeAnswer, formatAnswer] }],
      ["answers that are not a list", { cancelled: false, answers: undefined }],
    ];

    for (const [reason, result] of rejected) {
      expect(`${reason}: ${manager.completeCurrent(id, result as any)}`).toBe(`${reason}: false`);
      expect(manager.current()?.id).toBe(id);
      expect(manager.current()?.answers.size).toBe(0);
    }

    // The request survived every rejection, so it can still be answered.
    expect(manager.completeCurrent(id, {
      cancelled: false,
      answers: [scopeAnswer, formatAnswer],
    })).toBe(true);
    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [scopeAnswer, formatAnswer],
    });
    unsubscribe();
  });

  test("ignores a result carrying a stale request id", async () => {
    const { manager, unsubscribe } = mountedManager();
    const first = manager.request({ id: "main", name: "main" }, [questions[0]!]);
    const second = manager.request({ id: "child", name: "child" }, [questions[0]!]);
    const firstId = manager.current()!.id;
    const complete = { cancelled: false, answers: [scopeAnswer] };

    // An id belonging to no request at all.
    expect(manager.completeCurrent(`${firstId}-gone`, complete)).toBe(false);

    manager.cancel();
    await expect(first).resolves.toEqual({ cancelled: true, answers: [] });

    // Cancelled, and the queue advanced onto a different request.
    const secondId = manager.current()!.id;
    expect(secondId).not.toBe(firstId);
    expect(manager.completeCurrent(firstId, complete)).toBe(false);
    expect(manager.current()?.id).toBe(secondId);

    expect(manager.completeCurrent(secondId, complete)).toBe(true);
    await expect(second).resolves.toEqual({ cancelled: false, answers: [scopeAnswer] });

    // Already completed, so the same id must not resolve anything twice.
    expect(manager.completeCurrent(secondId, complete)).toBe(false);
    unsubscribe();
  });

  test("ignores a result for a request its requester already aborted", async () => {
    const { manager, unsubscribe } = mountedManager();
    const controller = new AbortController();
    const pending = manager.request({ id: "main", name: "main" }, [questions[0]!], controller.signal);
    const id = manager.current()!.id;

    controller.abort();
    await expect(pending).resolves.toEqual({ cancelled: true, answers: [] });
    expect(manager.completeCurrent(id, { cancelled: false, answers: [scopeAnswer] })).toBe(false);
    unsubscribe();
  });

  test("cancels the shown and queued requests of one requester only", async () => {
    const { manager, unsubscribe } = mountedManager();
    const child = { id: "child", name: "child" };
    const first = manager.request(child, [questions[0]!]);
    const second = manager.request({ id: "main", name: "main" }, [questions[0]!]);
    const third = manager.request(child, [questions[0]!]);
    const fourth = manager.request({ id: "other", name: "other" }, [questions[0]!]);

    manager.cancelRequester("child");

    await expect(first).resolves.toEqual({ cancelled: true, answers: [] });
    await expect(third).resolves.toEqual({ cancelled: true, answers: [] });

    // Removing the head promotes the next survivor and keeps the rest in order.
    expect(manager.current()?.requester.id).toBe("main");
    manager.cancel();
    await expect(second).resolves.toEqual({ cancelled: true, answers: [] });
    expect(manager.current()?.requester.id).toBe("other");
    manager.cancel();
    await expect(fourth).resolves.toEqual({ cancelled: true, answers: [] });
    expect(manager.current()).toBeUndefined();
    unsubscribe();
  });

  test("leaves other requesters alone and never takes identity from the caller", async () => {
    const { manager, unsubscribe } = mountedManager();
    const pending = manager.request({ id: "main", name: "main" }, [questions[0]!]);

    manager.cancelRequester("child");
    expect(manager.current()?.requester).toEqual({ id: "main", name: "main" });

    expect(manager.completeCurrent(manager.current()!.id, {
      cancelled: false,
      answers: [scopeAnswer],
    })).toBe(true);
    await expect(pending).resolves.toEqual({ cancelled: false, answers: [scopeAnswer] });
    unsubscribe();
  });
});
