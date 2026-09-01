import { describe, expect, test } from "bun:test";
import {
  formatOrcaStatus,
  isOrcaTerminal,
  OrcaStatusController,
  resolveOrcaStatusState,
} from "../src/orca-status";

describe("Orca terminal detection", () => {
  test("detects Orca from its terminal name or pane key", () => {
    expect(isOrcaTerminal({ TERM_PROGRAM: "Orca" })).toBe(true);
    expect(isOrcaTerminal({ TERM_PROGRAM: "orca" })).toBe(true);
    expect(isOrcaTerminal({ ORCA_PANE_KEY: "pane" })).toBe(true);
  });

  test("stays disabled in other terminals", () => {
    expect(isOrcaTerminal({ TERM_PROGRAM: "Windows_Terminal" })).toBe(false);
    expect(isOrcaTerminal({})).toBe(false);
  });
});

describe("Orca status formatting", () => {
  test("writes an OSC 9999 JSON payload terminated by BEL", () => {
    expect(formatOrcaStatus({ state: "working", model: "mock/model" })).toBe(
      "\x1b]9999;{\"state\":\"working\",\"agentType\":\"pi\",\"model\":\"mock/model\"}\x07",
    );
  });

  test("omits empty optional fields", () => {
    expect(formatOrcaStatus({ state: "done" })).toBe(
      "\x1b]9999;{\"state\":\"done\",\"agentType\":\"pi\"}\x07",
    );
  });
});

describe("Orca status resolution", () => {
  test("gives user input priority over active work", () => {
    expect(resolveOrcaStatusState({ working: true, waitingForUser: true })).toBe("waiting");
    expect(resolveOrcaStatusState({ working: true, waitingForUser: false })).toBe("working");
    expect(resolveOrcaStatusState({ working: false, waitingForUser: false })).toBe("done");
  });
});

describe("Orca status updates", () => {
  test("marks initial idle as a session boundary and reports later completion", () => {
    const writes: string[] = [];
    const status = new OrcaStatusController(true, (sequence) => writes.push(sequence));

    expect(status.update({ state: "done", model: "mock/model" })).toBe(true);
    expect(status.update({ state: "done", model: "mock/model" })).toBe(false);
    expect(status.update({ state: "working", model: "mock/model" })).toBe(true);
    expect(status.update({ state: "waiting", model: "mock/model" })).toBe(true);
    expect(status.update({ state: "working", model: "mock/model" })).toBe(true);
    expect(status.update({ state: "done", model: "mock/model" })).toBe(true);

    expect(writes[0]).toContain('"state":"done"');
    expect(writes[0]).toContain('"sessionBoundary":true');
    expect(writes.at(-1)).toContain('"state":"done"');
    expect(writes.at(-1)).not.toContain("sessionBoundary");
  });

  test("marks a new session as a boundary after earlier work", () => {
    const writes: string[] = [];
    const status = new OrcaStatusController(true, (sequence) => writes.push(sequence));

    status.update({ state: "working", sessionKey: "first" });
    status.update({ state: "done", sessionKey: "first" });
    status.update({ state: "done", sessionKey: "second" });

    expect(writes[1]).not.toContain("sessionBoundary");
    expect(writes[2]).toContain('"sessionBoundary":true');
  });

  test("does not write outside Orca", () => {
    const writes: string[] = [];
    const status = new OrcaStatusController(false, (sequence) => writes.push(sequence));

    expect(status.update({ state: "working" })).toBe(false);
    expect(writes).toEqual([]);
  });

  test("retries after a sink failure", () => {
    let attempts = 0;
    const status = new OrcaStatusController(true, () => {
      attempts += 1;
      throw new Error("closed output");
    });

    expect(status.update({ state: "working" })).toBe(false);
    expect(status.update({ state: "working" })).toBe(false);
    expect(attempts).toBe(2);
  });
});
