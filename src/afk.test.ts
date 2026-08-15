import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AfkController,
  DEFAULT_AFK_GUIDANCE,
  MAX_AFK_INSTRUCTIONS,
  afkInstructionProblem,
  composeAfkGuidance,
} from "./afk";

const NUL = "\u0000";

describe("afk toggle rules", () => {
  test("inactive and bare starts on the built-in guidance", () => {
    const afk = new AfkController();
    expect(afk.active()).toBe(false);

    const result = afk.toggle();
    expect(result).toEqual({ kind: "started", instructions: "", generation: 1 });
    expect(afk.active()).toBe(true);
    expect(afk.instructions()).toBe("");
    expect(afk.guidance()).toBe(DEFAULT_AFK_GUIDANCE);
  });

  test("inactive with instructions starts on them", () => {
    const afk = new AfkController();
    expect(afk.toggle("say yes to lint fixes"))
      .toEqual({ kind: "started", instructions: "say yes to lint fixes", generation: 1 });
    expect(afk.active()).toBe(true);
    expect(afk.instructions()).toBe("say yes to lint fixes");
    expect(afk.guidance()).toContain("say yes to lint fixes");
  });

  test("active and bare stops", () => {
    const afk = new AfkController();
    afk.toggle("keep going");
    expect(afk.toggle()).toEqual({ kind: "stopped", generation: 2 });
    expect(afk.active()).toBe(false);
  });

  test("active with instructions replaces the guidance and stays active", () => {
    const afk = new AfkController();
    afk.toggle("first steer");
    const result = afk.toggle("second steer");

    expect(result).toEqual({ kind: "updated", instructions: "second steer", generation: 2 });
    expect(afk.active()).toBe(true);
    expect(afk.instructions()).toBe("second steer");
    expect(afk.guidance()).not.toContain("first steer");
  });

  test("instructions replace the default too, without a stop in between", () => {
    const afk = new AfkController();
    afk.toggle();
    expect(afk.toggle("prefer the listed option").kind).toBe("updated");
    expect(afk.active()).toBe(true);
  });

  test("three bare toggles land on active again", () => {
    const afk = new AfkController();
    afk.toggle();
    afk.toggle();
    afk.toggle();
    expect(afk.active()).toBe(true);
    expect(afk.generation()).toBe(3);
  });

  test("blank instructions count as bare", () => {
    const afk = new AfkController();
    expect(afk.toggle("   \n  ").kind).toBe("started");
    expect(afk.instructions()).toBe("");
    expect(afk.toggle("  ").kind).toBe("stopped");
  });

  test("instructions are trimmed before they are stored", () => {
    const afk = new AfkController();
    afk.toggle("  be careful  ");
    expect(afk.instructions()).toBe("be careful");
  });
});

describe("afk stopping", () => {
  test("stopping clears the guidance from memory", () => {
    const afk = new AfkController();
    afk.toggle("a secret steer");
    afk.stop();

    expect(afk.instructions()).toBe("");
    expect(afk.guidance()).toBe("");
    expect(afk.status().instructions).toBe("");
    expect(JSON.stringify(afk)).not.toContain("a secret steer");
  });

  test("stopping bumps the generation, so an in-flight delegate result is stale", () => {
    const afk = new AfkController();
    afk.toggle("steer");
    const inFlight = afk.generation();
    expect(afk.isCurrent(inFlight)).toBe(true);

    afk.stop();
    expect(afk.isCurrent(inFlight)).toBe(false);
  });

  test("a replaced guidance also invalidates the running delegate", () => {
    const afk = new AfkController();
    afk.toggle("first");
    const inFlight = afk.generation();
    afk.toggle("second");

    expect(afk.isCurrent(inFlight)).toBe(false);
    expect(afk.isCurrent(afk.generation())).toBe(true);
  });

  test("no generation is ever reused", () => {
    const afk = new AfkController();
    const seen = new Set<number>();
    for (let round = 0; round < 6; round += 1) {
      afk.toggle(round % 2 === 0 ? undefined : "steer");
      seen.add(afk.generation());
    }
    expect(seen.size).toBe(6);
  });

  test("stopping an inactive controller is idempotent and bumps nothing", () => {
    const afk = new AfkController();
    expect(afk.stop()).toEqual({ kind: "stopped", generation: 0 });
    expect(afk.generation()).toBe(0);
    expect(afk.isCurrent(0)).toBe(false);
  });

  test("an inactive controller accepts no delegate result", () => {
    const afk = new AfkController();
    afk.toggle();
    const generation = afk.generation();
    afk.stop();
    afk.toggle();

    // The new run is a new generation, so the old delegate still cannot answer.
    expect(afk.isCurrent(generation)).toBe(false);
  });
});

describe("afk guidance bounds", () => {
  test("instructions at the limit are accepted", () => {
    const afk = new AfkController();
    const limit = "a".repeat(MAX_AFK_INSTRUCTIONS);
    expect(afk.toggle(limit).kind).toBe("started");
    expect(afk.instructions()).toBe(limit);
  });

  test("overlong instructions are rejected and change nothing", () => {
    const afk = new AfkController();
    const result = afk.toggle("a".repeat(MAX_AFK_INSTRUCTIONS + 1));

    expect(result.kind).toBe("rejected");
    expect(afk.active()).toBe(false);
    expect(afk.generation()).toBe(0);
  });

  test("a rejected update leaves a running AFK untouched", () => {
    const afk = new AfkController();
    afk.toggle("good steer");
    const generation = afk.generation();

    expect(afk.toggle(`bad${NUL}steer`).kind).toBe("rejected");
    expect(afk.active()).toBe(true);
    expect(afk.instructions()).toBe("good steer");
    expect(afk.generation()).toBe(generation);
  });

  test("NUL bytes are refused wherever they sit", () => {
    expect(afkInstructionProblem(`${NUL}`)).toContain("NUL");
    expect(afkInstructionProblem(`mid${NUL}dle`)).toContain("NUL");
    expect(afkInstructionProblem("clean text")).toBeUndefined();
    expect(afkInstructionProblem("a".repeat(MAX_AFK_INSTRUCTIONS))).toBeUndefined();
  });
});

describe("afk delegate guidance", () => {
  test("the default covers every rule the delegate has to follow", () => {
    const text = DEFAULT_AFK_GUIDANCE.toLowerCase();
    expect(text).toContain("reversible");
    expect(text).toContain("advances the user's current request");
    expect(text).toContain("did not ask for");
    expect(text).toContain("prefer a listed option");
    expect(text).toContain("custom answer only when");
    expect(text).toContain("bypass pum security rules");
    expect(text).toContain("instead of guessing");
  });

  test("user instructions are appended to the default, never replacing it", () => {
    const composed = composeAfkGuidance("always pick the fastest option");
    expect(composed.startsWith(DEFAULT_AFK_GUIDANCE)).toBe(true);
    expect(composed).toContain("always pick the fastest option");
  });

  test("the appended block says instructions grant no tools or permissions", () => {
    const composed = composeAfkGuidance("do whatever it takes").toLowerCase();
    expect(composed).toContain("decision guidance");
    expect(composed).toContain("no tools");
    expect(composed).toContain("no permissions");
  });

  test("empty instructions leave the default alone", () => {
    expect(composeAfkGuidance("")).toBe(DEFAULT_AFK_GUIDANCE);
    expect(composeAfkGuidance("   ")).toBe(DEFAULT_AFK_GUIDANCE);
  });

  test("begin hands out the guidance and its generation together", () => {
    const afk = new AfkController();
    expect(afk.begin()).toBeUndefined();

    afk.toggle("prefer the smallest change");
    const run = afk.begin();
    expect(run).toEqual({
      guidance: composeAfkGuidance("prefer the smallest change"),
      generation: 1,
    });

    // The guidance a delegate holds and the generation it is judged by cannot
    // drift apart: a replacement invalidates the pair it was taken from.
    afk.toggle("new steer");
    expect(afk.isCurrent(run!.generation)).toBe(false);
    expect(afk.begin()?.generation).toBe(2);

    afk.stop();
    expect(afk.begin()).toBeUndefined();
  });
});

describe("afk subscription", () => {
  test("subscribe reports the current state at once", () => {
    const afk = new AfkController();
    let seen = 0;
    afk.subscribe(() => { seen += 1; });
    expect(seen).toBe(1);
  });

  test("every state change emits to every listener", () => {
    const afk = new AfkController();
    const first: number[] = [];
    const second: number[] = [];
    afk.subscribe(() => first.push(afk.generation()));
    afk.subscribe(() => second.push(afk.generation()));

    afk.toggle("steer");
    afk.toggle("new steer");
    afk.toggle();

    expect(first).toEqual([0, 1, 2, 3]);
    expect(second).toEqual([0, 1, 2, 3]);
  });

  test("a rejected command emits nothing", () => {
    const afk = new AfkController();
    let calls = 0;
    afk.subscribe(() => { calls += 1; });
    afk.toggle(`bad${NUL}`);
    expect(calls).toBe(1);
  });

  test("unsubscribing stops the listener", () => {
    const afk = new AfkController();
    let calls = 0;
    const unsubscribe = afk.subscribe(() => { calls += 1; });
    unsubscribe();
    afk.toggle();
    expect(calls).toBe(1);
  });

  test("the snapshot is stable between changes and fresh after one", () => {
    const afk = new AfkController();
    const before = afk.status();
    expect(afk.status()).toBe(before);

    afk.toggle("steer");
    const after = afk.status();
    expect(after).not.toBe(before);
    expect(after).toEqual({ active: true, instructions: "steer", generation: 1 });
    expect(afk.status()).toBe(after);
  });
});

describe("afk state stays in the process", () => {
  const sources = ["afk.ts", "afk-command.ts"];

  test("neither module can reach the filesystem or settings", () => {
    for (const name of sources) {
      const source = readFileSync(join(import.meta.dir, name), "utf8");
      expect(source).not.toContain("node:fs");
      expect(source).not.toContain("localStorage");
      for (const forbidden of ["./settings", "./news", "./history", "./prompt-stash", "./replay"]) {
        expect(source).not.toContain(`from "${forbidden}"`);
      }
    }
  });

  test("a fresh controller is always off, so a restart never resumes AFK", () => {
    const before = new AfkController();
    before.toggle("steer that must not survive");

    const afterRestart = new AfkController();
    expect(afterRestart.active()).toBe(false);
    expect(afterRestart.instructions()).toBe("");
    expect(afterRestart.generation()).toBe(0);
  });

  test("the API offers no way for a user message to end AFK", () => {
    const surface = Object.getOwnPropertyNames(AfkController.prototype)
      .filter((name) => name !== "constructor" && !name.startsWith("advance"))
      .sort();
    expect(surface).toEqual([
      "active",
      "begin",
      "generation",
      "guidance",
      "instructions",
      "isCurrent",
      "status",
      "stop",
      "subscribe",
      "toggle",
    ]);

    // Only toggle and stop mutate, and neither runs for an ordinary message.
    const afk = new AfkController();
    afk.toggle("steer");
    afk.guidance();
    afk.status();
    afk.instructions();
    afk.isCurrent(99);
    expect(afk.active()).toBe(true);
    expect(afk.generation()).toBe(1);
  });
});
