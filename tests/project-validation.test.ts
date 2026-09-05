import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseValidationConfig, ProjectValidationController, readValidationProposal,
  VALIDATION_MAX_CONFIG_BYTES, validationForSession, type ValidationEvidence,
} from "../src/project-validation";

// Pure configuration, filesystem trust, and runtime authority tests. Real SDK
// dispatch/persistence is deliberately covered by project-validation-sdk.test.ts.
const roots: string[] = [];
const controllers: ProjectValidationController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const command = { kind: "test", command: "fixture-test", timeoutSeconds: 1 };
const config = (extra: Record<string, unknown> = {}) => ({ version: 1, commands: [command], ...extra });
const parse = (value: unknown): unknown => parseValidationConfig(JSON.stringify(value));
function fixture() {
  // Canonicalize the system temp root (notably /var on macOS), since proposals
  // intentionally reject symlinks in every ancestor component.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pum-validation-unit-")));
  roots.push(cwd);
  mkdirSync(join(cwd, ".pum"));
  const path = join(cwd, ".pum", "validation.json");
  const bytes = JSON.stringify(config());
  writeFileSync(path, bytes);
  return { cwd, path, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}
function runtime(cwd: string, options: { id?: string; readonly?: boolean; execute?: () => Promise<unknown> } = {}) {
  const controller = new ProjectValidationController({ cwd, readonly: options.readonly });
  controllers.push(controller);
  const messages: { details: ValidationEvidence }[] = [];
  const calls: string[] = [];
  let disposed = 0;
  const session = {
    sessionId: options.id ?? randomUUID(), isStreaming: false,
    sessionManager: { getCwd: () => cwd }, dispose: () => { disposed++; },
    sendCustomMessage: async (message: { details: ValidationEvidence }) => { messages.push(message); },
    agent: { state: { messages: [], systemPrompt: "", tools: [{ name: "bash", execute: async () => {
      calls.push("execute");
      return options.execute ? options.execute() : { content: [{ type: "text", text: "ok" }] };
    } }] }, beforeToolCall: async () => { calls.push("check"); return {}; } },
  } as unknown as AgentSession;
  controller.bind(session);
  const handlers = new Map<string, (...args: any[]) => any>();
  const extension = controller.extension();
  if (typeof extension === "function") throw new Error("Expected named validation extension");
  extension.factory({ on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler) } as any);
  const mutate = () => handlers.get("tool_result")!({ toolName: "edit", isError: false });
  const settle = () => handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop", content: [] } }, {});
  return { controller, session, messages, calls, mutate, settle, disposed: () => disposed };
}

describe("strict validation proposal schema", () => {
  test("defaults and exact inclusive bounds preserve literal command strings", () => {
    expect(parse(config())).toEqual({ ...config(), maxRuns: 5 });
    for (const maxRuns of [1, 20]) {
      const commands = ["format", "lint", "typecheck", "test"].map((kind, i) => ({
        kind, command: i === 0 ? " x " : "x".repeat(2048), timeoutSeconds: i % 2 ? 120 : 1,
      }));
      expect(parse(config({ commands, maxRuns }))).toEqual(config({ commands, maxRuns }));
    }
  });
  test.each(["", "{", "{\"version\":1,}", "undefined"])("rejects malformed JSON %j", (text) => {
    expect(() => parseValidationConfig(text)).toThrow("not valid JSON");
  });
  test("rejects nonobjects, missing fields, versions, unknown root fields and command counts", () => {
    for (const invalid of [null, [], true, 1, "config", {}, { commands: [command] },
      config({ version: "1" }), config({ version: 2 }), config({ commands: [] }),
      config({ commands: Array(5).fill(command) }), config({ commands: {} }),
      config({ cwd: "." }), config({ env: {} }), config({ repair: true }), config({ watch: true })]) {
      expect(() => parse(invalid)).toThrow();
    }
  });
  test.each([0, -1, 21, 1.5, "5", null, true])("rejects invalid maxRuns %j", (maxRuns) => {
    expect(() => parse(config({ maxRuns }))).toThrow();
  });
  test("rejects malformed commands and unknown command fields", () => {
    for (const invalid of [null, [], "test", {}, { ...command, kind: "TEST" }, { ...command, kind: ["test"] },
      { ...command, command: "" }, { ...command, command: "  " }, { ...command, command: 1 },
      { ...command, command: "x".repeat(2049) }, { ...command, cwd: "." }, { ...command, env: {} },
      ...[undefined, null, 0, -1, 121, 1.5, "1", true].map((timeoutSeconds) => ({ ...command, timeoutSeconds }))]) {
      expect(() => parse(config({ commands: [invalid] }))).toThrow();
    }
  });
  test("rejects every ASCII control character, including tabs, newlines and DEL", () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      expect(() => parse(config({ commands: [{ ...command, command: `echo a${String.fromCharCode(code)}b` }] }))).toThrow();
    }
  });
});

describe("bounded, literal-byte validation proposal loading", () => {
  test("digest pins exact bytes rather than normalized JSON", () => {
    const f = fixture();
    expect(readValidationProposal(f.cwd)).toEqual({ digest: f.digest, config: parseValidationConfig(f.bytes) });
    writeFileSync(f.path, `${f.bytes}\n`);
    expect(readValidationProposal(f.cwd).digest).not.toBe(f.digest);
    expect(readValidationProposal(f.cwd).config).toEqual(parseValidationConfig(f.bytes));
  });
  test("accepts the byte limit and rejects one byte over", () => {
    const f = fixture();
    writeFileSync(f.path, f.bytes.padEnd(VALIDATION_MAX_CONFIG_BYTES));
    expect(readValidationProposal(f.cwd).config.maxRuns).toBe(5);
    writeFileSync(f.path, f.bytes.padEnd(VALIDATION_MAX_CONFIG_BYTES + 1));
    expect(() => readValidationProposal(f.cwd)).toThrow("at most 16 KiB");
  });
  test.each(["missing", "directory", "hardlink", "symlink", "malformed"])("rejects %s config without exposing contents", (kind) => {
    const f = fixture();
    if (kind === "hardlink") linkSync(f.path, join(f.cwd, "alias.json"));
    else if (kind === "malformed") writeFileSync(f.path, "private malformed fixture text");
    else {
      rmSync(f.path);
      if (kind === "directory") mkdirSync(f.path);
      if (kind === "symlink") {
        writeFileSync(join(f.cwd, "target.json"), f.bytes);
        symlinkSync(join(f.cwd, "target.json"), f.path);
      }
    }
    expect(() => readValidationProposal(f.cwd)).toThrow("Cannot load .pum/validation.json");
  });
  test("rejects linked configuration directory and linked cwd ancestors", () => {
    const f = fixture();
    rmSync(join(f.cwd, ".pum"), { recursive: true });
    mkdirSync(join(f.cwd, "config"));
    writeFileSync(join(f.cwd, "config", "validation.json"), f.bytes);
    symlinkSync(join(f.cwd, "config"), join(f.cwd, ".pum"), "junction");
    expect(() => readValidationProposal(f.cwd)).toThrow();
    const other = fixture();
    symlinkSync(other.cwd, join(f.cwd, "project-alias"), "junction");
    expect(() => readValidationProposal(join(f.cwd, "project-alias"))).toThrow();
  });
});

describe("runtime-only validation authority", () => {
  test("preview is inert and readonly/unbound runtimes cannot approve", async () => {
    const f = fixture();
    const r = runtime(f.cwd);
    expect(r.controller.preview()).toContain(f.digest);
    expect(r.controller.preview()).toContain("current/future project code");
    r.mutate(); await r.settle();
    expect(r.calls).toEqual([]); expect(r.messages).toEqual([]);
    expect(r.controller.status()).toContain("disabled");
    const readonly = runtime(f.cwd, { readonly: true });
    expect(readonly.controller.preview()).toContain("readonly");
    expect(() => readonly.controller.enable(f.digest)).toThrow("readonly");
    readonly.mutate(); await readonly.settle(); expect(readonly.calls).toEqual([]);
    const unbound = new ProjectValidationController({ cwd: f.cwd });
    controllers.push(unbound);
    expect(() => unbound.enable(f.digest)).toThrow("unavailable");
  });
  test("approval accepts uppercase digest but rejects malformed/mismatched consent", () => {
    const f = fixture(); const r = runtime(f.cwd);
    for (const digest of ["", f.digest.slice(1), `${f.digest}0`, "g".repeat(64), "0".repeat(64), ` ${f.digest}`]) {
      expect(() => r.controller.enable(digest)).toThrow("digest");
      expect(r.controller.status()).toContain("disabled");
    }
    r.controller.enable(f.digest.toUpperCase());
    expect(r.controller.status()).toContain("enabled");
  });
  test.each(["changed", "missing", "invalid"])("%s config revokes consent before checked execution", async (kind) => {
    const f = fixture(); const r = runtime(f.cwd); r.controller.enable(f.digest);
    if (kind === "missing") rmSync(f.path);
    else writeFileSync(f.path, kind === "changed" ? `${f.bytes}\n` : "{");
    r.mutate(); await r.settle();
    expect(r.calls).toEqual([]);
    expect(r.controller.status()).toContain("disabled");
    expect(r.messages[0]?.details.outcome).toBe("skipped");
    expect(r.messages[0]?.details.reason).toContain("consent revoked");
    writeFileSync(f.path, f.bytes);
    r.mutate(); await r.settle(); expect(r.calls).toEqual([]);
    expect(r.messages).toHaveLength(1);
  });
  test("preview digest must still match when enabled", () => {
    const f = fixture(); const r = runtime(f.cwd); r.controller.preview();
    writeFileSync(f.path, `${f.bytes}\n`);
    expect(() => r.controller.enable(f.digest)).toThrow("digest");
    rmSync(f.path);
    expect(() => r.controller.enable(f.digest)).toThrow("Cannot load");
  });
  test("same-cwd children and same-ID replacement never inherit approval", async () => {
    const f = fixture(); const first = runtime(f.cwd); first.controller.enable(f.digest);
    const child = runtime(f.cwd);
    expect(child.controller.status()).toContain("disabled");
    const replacement = runtime(f.cwd, { id: first.session.sessionId });
    expect(first.controller.status()).toContain("disposed");
    expect(validationForSession(first.session)).toBeUndefined();
    expect(validationForSession(replacement.session.sessionId)).toBe(replacement.controller);
    expect(replacement.controller.status()).toContain("disabled");
    first.mutate(); await first.settle(); replacement.mutate(); await replacement.settle();
    expect(first.calls).toEqual([]); expect(replacement.calls).toEqual([]);
    first.controller.dispose();
    expect(validationForSession(replacement.session.sessionId)).toBe(replacement.controller);
    expect(() => first.controller.enable(f.digest)).toThrow("unavailable");
  });
  test("session disposal unregisters authority and cannot be rebound", () => {
    const f = fixture(); const r = runtime(f.cwd); r.controller.enable(f.digest);
    r.session.dispose();
    expect(r.disposed()).toBe(1);
    expect(validationForSession(r.session)).toBeUndefined();
    expect(validationForSession(r.session.sessionId)).toBeUndefined();
    expect(() => r.controller.enable(f.digest)).toThrow();
    expect(() => r.controller.bind(r.session)).toThrow();
  });
  test("disposal restores owned hooks and preserves wrappers installed afterwards", () => {
    const f = fixture(); const first = runtime(f.cwd);
    expect(first.session.agent.prepareNextTurnWithContext).toBeFunction();
    expect(first.session.agent.shouldStopAfterTurn).toBeFunction();
    first.controller.dispose();
    expect(first.session.agent.prepareNextTurnWithContext).toBeUndefined();
    expect(first.session.agent.shouldStopAfterTurn).toBeUndefined();
    const second = runtime(f.cwd);
    const prepare: NonNullable<AgentSession["agent"]["prepareNextTurnWithContext"]> = async () => undefined;
    const stop = async () => false;
    second.session.agent.prepareNextTurnWithContext = prepare;
    second.session.agent.shouldStopAfterTurn = stop;
    second.controller.dispose();
    expect(second.session.agent.prepareNextTurnWithContext).toBe(prepare);
    expect(second.session.agent.shouldStopAfterTurn).toBe(stop);
  });
  test("streaming and cwd mismatch refuse authority", () => {
    const f = fixture(); const r = runtime(f.cwd);
    Object.defineProperty(r.session, "isStreaming", { value: true });
    expect(() => r.controller.enable(f.digest)).toThrow("idle");
    const other = fixture(); const c = new ProjectValidationController({ cwd: other.cwd }); controllers.push(c);
    expect(() => c.bind(r.session)).toThrow("cwd");
    expect(validationForSession(r.session)).toBe(r.controller);
  });
  test("same-cwd runtime lock skips competitors without polling and releases on settlement", async () => {
    const f = fixture();
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const first = runtime(f.cwd, { execute: async () => {
      started(); await gate; return { content: [{ type: "text", text: "ok" }] };
    } });
    const second = runtime(f.cwd);
    first.controller.enable(f.digest); second.controller.enable(f.digest);
    first.mutate(); const settling = first.settle();
    try {
      await entered;
      second.mutate(); await second.settle();
      expect(second.calls).toEqual([]);
      expect(second.messages[0]?.details.outcome).toBe("skipped");
      expect(second.messages[0]?.details.reason).toContain("Another runtime");
      expect(second.controller.status()).toContain("0/5");
    } finally { release(); await settling; }
    expect(first.messages[0]?.details.outcome).toBe("passed");
    second.mutate(); await second.settle();
    expect(second.calls).toEqual(["check", "execute"]);
    expect(second.messages[1]?.details.outcome).toBe("passed");
  });
});
