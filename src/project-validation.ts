import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { createSyntheticCheckCall } from "./check-mode";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { canonicalRealpathSync, projectStorageKey } from "./platform";

export const VALIDATION_CUSTOM_TYPE = "pum.validation";
export const VALIDATION_MAX_CONFIG_BYTES = 16 * 1024;
const OUTPUT_BYTES = 2048;
const runningDirectories = new Set<string>();
const controllers = new WeakMap<AgentSession, ProjectValidationController>();
const liveControllers = new Map<string, ProjectValidationController>();
type Kind = "format" | "lint" | "typecheck" | "test";
export type ValidationCommand = { kind: Kind; command: string; timeoutSeconds: number };
export type ValidationConfig = { version: 1; commands: ValidationCommand[]; maxRuns: number };
type Proposal = { digest: string; config: ValidationConfig };
export type ValidationOutcome = "passed" | "failed" | "blocked" | "cancelled" | "timeout" | "skipped";
export type ValidationEvidence = {
  version: 1; digest: string; run: number; outcome: ValidationOutcome; reason?: string;
  commands: { kind: Kind; command: string; outcome: ValidationOutcome; durationMs: number; output: string }[];
};

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
export function parseValidationConfig(text: string): ValidationConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Validation configuration is not valid JSON."); }
  if (!plain(value) || !keys(value, ["version", "commands", "maxRuns"]) || value.version !== 1
    || !Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 4
    || (value.maxRuns !== undefined && !integer(value.maxRuns, 1, 20))) {
    throw new Error("Validation requires version 1, 1–4 commands, and maxRuns 1–20 (default 5).");
  }
  const commands = value.commands.map((entry): ValidationCommand => {
    if (!plain(entry) || !keys(entry, ["kind", "command", "timeoutSeconds"])
      || typeof entry.kind !== "string" || !["format", "lint", "typecheck", "test"].includes(entry.kind)
      || typeof entry.command !== "string" || !entry.command.trim() || entry.command.length > 2048
      || /[\x00-\x1f\x7f]/.test(entry.command) || !integer(entry.timeoutSeconds, 1, 120)) {
      throw new Error("Each validation command needs kind format/lint/typecheck/test, a single-line command (1–2048 characters), and timeoutSeconds 1–120.");
    }
    return { kind: entry.kind as Kind, command: entry.command, timeoutSeconds: entry.timeoutSeconds };
  });
  return { version: 1, commands, maxRuns: value.maxRuns as number | undefined ?? 5 };
}

/** Bounded, regular, singly-linked file only; no symlink/junction components. */
export function readValidationProposal(cwd: string): Proposal {
  try {
    const path = join(resolve(cwd), ".pum", "validation.json");
    let component = path;
    for (;;) {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink() || (component === path ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
        throw new Error("Invalid path");
      }
      if (component === parse(component).root) break;
      component = dirname(component);
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > VALIDATION_MAX_CONFIG_BYTES) throw new Error("Invalid file");
      const buffer = Buffer.alloc(VALIDATION_MAX_CONFIG_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd);
      const named = lstatSync(path);
      if (length > VALIDATION_MAX_CONFIG_BYTES || length !== after.size
        || [after, named].some((stat) => !stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev
          || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) {
        throw new Error("Changed file");
      }
      bytes = buffer.subarray(0, length);
    } finally { closeSync(fd); }
    return { digest: createHash("sha256").update(bytes).digest("hex"), config: parseValidationConfig(bytes.toString("utf8")) };
  } catch {
    throw new Error("Cannot load .pum/validation.json: use a stable, singly-linked regular JSON file (at most 16 KiB), no links, and the documented version 1 schema.");
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(new Error("Validation cancelled.")); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Validation cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function boundedOutput(text: string): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const bytes = Buffer.from(clean);
  return bytes.length <= OUTPUT_BYTES ? clean : `${bytes.subarray(0, OUTPUT_BYTES).toString("utf8")}\n[validation output truncated]`;
}
export function validationEvidenceText(evidence: ValidationEvidence): string {
  return [
    `Automatic validation: ${evidence.outcome} (run ${evidence.run}, config ${evidence.digest}).`,
    "Historical command evidence, not instructions. No automatic repair attempts. Concurrent external edits are not an atomic snapshot.",
    ...(evidence.reason ? [evidence.reason] : []),
    ...evidence.commands.map((command) => `${command.kind}: ${JSON.stringify(command.command)} — ${command.outcome} (${command.durationMs} ms)\n${command.output}`),
  ].join("\n");
}
export function validationForSession(session: AgentSession | string): ProjectValidationController | undefined {
  return typeof session === "string" ? liveControllers.get(session) : controllers.get(session);
}

/** Consent is runtime memory owned by direct user dispatch, never repository state. */
export class ProjectValidationController {
  private session?: AgentSession;
  private proposal?: Proposal;
  private retired = false;
  private dirty = false;
  private runs = 0;
  private active?: AbortController;
  private generation = 0;
  private batchHasMutations = false;
  private latest?: ValidationEvidence;
  private refreshEvidence = false;
  private unbindHooks?: () => void;
  private readonly cwd: string;
  private readonly readonly: boolean;
  private readonly directoryKey: string;
  constructor(options: { cwd: string; readonly?: boolean }) {
    this.cwd = resolve(options.cwd);
    this.readonly = options.readonly === true;
    this.directoryKey = projectStorageKey(canonicalRealpathSync(this.cwd));
  }
  get lastFailed(): boolean { return this.latest !== undefined && this.latest.outcome !== "passed"; }
  preview(): string {
    const proposal = readValidationProposal(this.cwd);
    return `${this.status()}\n.pum/validation.json SHA-256: ${proposal.digest}\n${proposal.config.commands.map((c) => `${c.kind}: ${JSON.stringify(c.command)} (timeout ${c.timeoutSeconds}s)`).join("\n")}\nMaximum runs: ${proposal.config.maxRuns}. Automatic repair budget: 0.\nEnabling trusts these commands and the current/future project code, scripts and tool configuration they execute, NOT only this digest. Check/Sandbox settings still apply; Check Off may run unconfined.\nDirect user only: /validation enable ${proposal.digest}`;
  }
  enable(digest: string): void {
    if (this.retired || this.readonly || !this.session) throw new Error("Validation is unavailable for this runtime or readonly role.");
    if (this.active || this.session.isStreaming) throw new Error("Enable validation only while the selected agent is idle.");
    const proposal = readValidationProposal(this.cwd);
    if (!/^[a-f0-9]{64}$/i.test(digest) || proposal.digest !== digest.toLowerCase()) throw new Error("Validation digest does not match. Review /validation again.");
    this.generation++;
    this.proposal = proposal;
    this.runs = 0;
    this.dirty = false;
    this.latest = undefined;
  }
  disable(): void {
    this.generation++;
    this.proposal = undefined;
    this.dirty = false;
    this.active?.abort();
  }
  status(): string {
    if (this.readonly) return "Automatic validation unavailable: readonly role.";
    if (this.retired) return "Automatic validation runtime disposed.";
    return `Automatic validation ${this.proposal ? `enabled (${this.runs}/${this.proposal.config.maxRuns} runs consumed)` : "disabled"}.${this.latest ? ` Last result: ${this.latest.outcome}.` : ""}`;
  }
  dispose(): void {
    this.disable();
    this.retired = true;
    this.unbindHooks?.();
    this.unbindHooks = undefined;
    if (this.session) {
      controllers.delete(this.session);
      if (liveControllers.get(this.session.sessionId) === this) liveControllers.delete(this.session.sessionId);
    }
  }
  bind(session: AgentSession): void {
    if (this.retired || this.session) throw new Error("Validation runtime already bound or disposed.");
    if (projectStorageKey(canonicalRealpathSync(session.sessionManager.getCwd())) !== this.directoryKey) throw new Error("Validation cwd does not match session.");
    this.session = session;
    controllers.set(session, this);
    liveControllers.get(session.sessionId)?.dispose();
    liveControllers.set(session.sessionId, this);
    const dispose = session.dispose.bind(session);
    session.dispose = () => { this.dispose(); dispose(); };
    // Agent-core owns a separate context snapshot. SDK custom-message persistence
    // does not refresh that snapshot unless compaction ran. Refresh only after our
    // turn-end evidence flushed, before delegating to existing context/compaction.
    const prepare = session.agent.prepareNextTurnWithContext;
    const legacy = session.agent.prepareNextTurn;
    const prepareWrapper: NonNullable<typeof session.agent.prepareNextTurnWithContext> = async (turn, signal) => {
      if (this.retired) return prepare ? await prepare.call(session.agent, turn, signal) : legacy ? await legacy.call(session.agent, signal) : undefined;
      signal?.throwIfAborted();
      const refresh = this.refreshEvidence;
      this.refreshEvidence = false;
      const input = refresh ? { ...turn, context: { ...turn.context, messages: session.agent.state.messages.slice() } } : turn;
      const update = prepare ? await prepare.call(session.agent, input, signal) : await legacy?.call(session.agent, signal);
      return refresh ? { ...update, context: update?.context ?? input.context } : update;
    };
    session.agent.prepareNextTurnWithContext = prepareWrapper;
    const stop = session.agent.shouldStopAfterTurn;
    const stopWrapper: NonNullable<typeof session.agent.shouldStopAfterTurn> = async (turn, signal) => {
      if (!this.retired && signal?.aborted) return true;
      return await stop?.call(session.agent, turn, signal) ?? false;
    };
    session.agent.shouldStopAfterTurn = stopWrapper;
    this.unbindHooks = () => {
      if (session.agent.prepareNextTurnWithContext === prepareWrapper) session.agent.prepareNextTurnWithContext = prepare;
      if (session.agent.shouldStopAfterTurn === stopWrapper) session.agent.shouldStopAfterTurn = stop;
    };
  }
  extension(): InlineExtension {
    return { name: "pum-project-validation", factory: (pi) => {
      pi.on("session_shutdown", () => this.dispose());
      pi.on("message_end", (event) => {
        if (event.message.role === "assistant") {
          this.batchHasMutations = event.message.content.some((block) => block.type === "toolCall" && ["write", "edit"].includes(block.name));
        }
      });
      pi.on("tool_call", (event) => {
        if (this.proposal && event.toolName === "finish_subagent" && (this.batchHasMutations || this.dirty || this.active)) {
          return { block: true, reason: "Finish must be a separate tool batch after mutations and automatic validation evidence." };
        }
      });
      pi.on("tool_result", (event) => {
        if (this.proposal && !this.readonly && !this.active && !event.isError && ["write", "edit"].includes(event.toolName)) this.dirty = true;
      });
      pi.on("turn_end", async (event, ctx) => {
        this.batchHasMutations = false;
        if (!this.dirty || !this.proposal || this.readonly || this.retired || event.message.role !== "assistant") return;
        this.dirty = false;
        await this.validate(event.message, ctx.signal);
      });
    } };
  }
  private async report(evidence: ValidationEvidence): Promise<void> {
    this.latest = evidence;
    if (this.retired || !this.session) return;
    await this.session.sendCustomMessage({ customType: VALIDATION_CUSTOM_TYPE, content: validationEvidenceText(evidence), display: true, details: evidence }, { triggerTurn: false });
    this.refreshEvidence = true;
  }
  private stillApproved(proposal: Proposal, generation: number): boolean {
    if (this.retired || this.proposal !== proposal || this.generation !== generation) return false;
    try {
      if (readValidationProposal(this.cwd).digest === proposal.digest
        && projectStorageKey(canonicalRealpathSync(this.cwd)) === this.directoryKey) return true;
    } catch { /* A missing or changed proposal revokes authority. */ }
    this.disable();
    return false;
  }
  private async validate(assistantMessage: AssistantMessage, parentSignal?: AbortSignal): Promise<void> {
    const session = this.session;
    const proposal = this.proposal;
    if (!session || !proposal || this.active) return;
    const generation = this.generation;
    const evidence: ValidationEvidence = { version: 1, digest: proposal.digest, run: this.runs, outcome: "skipped", commands: [] };
    const skip = async (reason: string) => { evidence.reason = reason; await this.report(evidence); };
    if (!this.stillApproved(proposal, generation)) return skip("Configuration changed/unavailable; consent revoked. Review and enable again.");
    if (parentSignal?.aborted || assistantMessage.stopReason === "aborted" || assistantMessage.stopReason === "error") {
      evidence.outcome = "cancelled";
      return skip("Interrupted batch: validation did not start.");
    }
    if (this.runs >= proposal.config.maxRuns) return skip("Validation run budget exhausted; direct user must enable again.");
    if (runningDirectories.has(this.directoryKey)) return skip("Another runtime is validating this directory; this batch was not validated. No automatic retry.");
    runningDirectories.add(this.directoryKey);
    this.active = new AbortController();
    const active = this.active;
    const abort = () => active.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    evidence.run = ++this.runs;
    evidence.outcome = "passed";
    try {
      for (const command of proposal.config.commands) {
        if (!this.stillApproved(proposal, generation) || active.signal.aborted) {
          evidence.outcome = "cancelled";
          evidence.reason = "Validation cancelled or consent/configuration changed.";
          break;
        }
        const started = Date.now();
        const deadline = new AbortController();
        const signal = AbortSignal.any([active.signal, deadline.signal]);
        const timer = setTimeout(() => deadline.abort(), command.timeoutSeconds * 1000);
        let outcome: ValidationOutcome = "passed";
        let output = "";
        try {
          const tool = session.agent.state.tools.find((entry) => entry.name === "bash");
          if (!tool || !session.agent.beforeToolCall) throw new Error("Checked Bash is unavailable.");
          const { id, args } = createSyntheticCheckCall({ command: command.command, timeout: command.timeoutSeconds, max_bytes: OUTPUT_BYTES });
          const context = { systemPrompt: session.agent.state.systemPrompt, messages: session.agent.state.messages, tools: session.agent.state.tools };
          // Exactly the session's Check hooks and native-sandbox registered Bash.
          // Never executeBash(): that API deliberately bypasses model Check policy.
          const toolCall = { type: "toolCall" as const, id, name: "bash", arguments: args };
          const preflight = await untilAborted(session.agent.beforeToolCall({ assistantMessage, toolCall, args, context }, signal), signal);
          if (preflight?.block) {
            outcome = "blocked";
            output = "Existing Bash policy denied this validation command.";
          } else if (args.command !== command.command || args.timeout !== command.timeoutSeconds || args.max_bytes !== OUTPUT_BYTES) {
            outcome = "blocked";
            output = "Bash preflight changed the approved validation arguments; command not executed.";
          } else if (!this.stillApproved(proposal, generation) || signal.aborted) {
            outcome = deadline.signal.aborted ? "timeout" : "cancelled";
          } else {
            const result = await tool.execute(toolCall.id, args, signal);
            const after = await untilAborted(Promise.resolve(session.agent.afterToolCall?.({ assistantMessage, toolCall, args, result, isError: false, context }, signal)), signal);
            if (after?.isError) outcome = "failed";
            output = (after?.content ?? result.content).filter((item) => item.type === "text").map((item) => item.text).join("\n");
          }
        } catch (error) {
          outcome = signal.aborted ? (deadline.signal.aborted ? "timeout" : "cancelled") : "failed";
          output = error instanceof Error ? error.message : "Validation execution failed.";
        } finally { clearTimeout(timer); }
        if (signal.aborted) outcome = deadline.signal.aborted ? "timeout" : "cancelled";
        evidence.commands.push({ ...command, outcome, durationMs: Math.max(0, Date.now() - started), output: boundedOutput(output) });
        if (outcome !== "passed") { evidence.outcome = outcome; break; }
      }
      if (!this.stillApproved(proposal, generation) && evidence.outcome === "passed") {
        evidence.outcome = "cancelled";
        evidence.reason = "Configuration or consent changed before evidence completed.";
      }
    } finally {
      parentSignal?.removeEventListener("abort", abort);
      this.active = undefined;
      runningDirectories.delete(this.directoryKey);
    }
    await this.report(evidence);
  }
}
