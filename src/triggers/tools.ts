import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

export type TriggerState =
  | "idle"
  | "running"
  | "paused"
  | "waiting"
  | "expired"
  | "cancelled"
  | "unavailable";

export type TriggerTarget = {
  sessionId: string;
  agentId: string | null;
  label: string;
};

export type TriggerOutputMetadata = {
  path: string;
  bytes: number;
  truncated: boolean;
  exists: boolean;
};

export type TriggerLastResult = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  synthetic: boolean;
  manual: boolean;
  output?: TriggerOutputMetadata;
};

export type TriggerSnapshot = {
  id: string;
  name: string;
  state: TriggerState;
  target: TriggerTarget;
  executable: string;
  args: string[];
  cwd: string;
  mode: "once" | "repeat";
  restartDelayMs: number | null;
  createdAt: number;
  expiresAt: number;
  nextRestartAt: number | null;
  fireCount: number;
  maxFires: number;
  pendingCount: number;
  coalescedCount: number;
  output?: TriggerOutputMetadata;
  lastResult?: TriggerLastResult;
  paused: boolean;
};

export type TriggerRequester =
  | { kind: "main"; sessionId: string; cwd: string }
  | { kind: "subagent"; sessionId: string; agentId: string; cwd: string };

export type CreateTriggerInput = {
  name: string;
  executable: string;
  args: string[];
  target: TriggerTarget;
  cwd: string;
  template: string;
  mode: "once" | "repeat";
  restartDelayMs?: number;
  lifetimeMs?: number;
  startBehavior: "start" | "paused";
};

export type TriggerTargetSelector =
  | { kind: "main" }
  | { kind: "subagent"; agent: string }
  | { kind: "self" };

export type CreateTriggerToolInput = Omit<CreateTriggerInput, "target" | "cwd"> & {
  target?: TriggerTargetSelector;
};

export interface TriggerToolManager {
  create(input: CreateTriggerInput, requester: TriggerRequester): Promise<TriggerSnapshot>;
  getTriggers(requester?: TriggerRequester): TriggerSnapshot[];
  inspect(id: string, requester?: TriggerRequester): TriggerSnapshot | Promise<TriggerSnapshot>;
  pause(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot>;
  resume(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot>;
  cancel(id: string, requester?: TriggerRequester): Promise<void>;
  invoke(
    id: string,
    mode: "run" | "fire",
    requester?: TriggerRequester,
  ): Promise<TriggerSnapshot | void>;
}

export interface TriggerRuntimeManager extends TriggerToolManager {
  subscribe(listener: () => void): () => void;
  invalidateSession(sessionId: string, reason?: string): Promise<void>;
  invalidateAgent(agentId: string, reason?: string): Promise<void>;
  markTargetSettled(sessionId: string, agentId?: string): Promise<void>;
  shutdown(): Promise<void>;
}

export type TriggerRequesterResolver = (
  context: ExtensionContext,
) => TriggerRequester | Promise<TriggerRequester>;

export type TriggerTargetResolver = (
  requester: TriggerRequester,
  selector: TriggerTargetSelector,
) => { target: TriggerTarget; cwd: string } | Promise<{ target: TriggerTarget; cwd: string }>;

export type TriggerToolRegistrationOptions = {
  audience: "main" | "subagent";
  resolveTarget?: TriggerTargetResolver;
  authorizeTarget?: (
    requester: TriggerRequester,
    target: TriggerTarget,
  ) => boolean | Promise<boolean>;
};

export function StringEnum<const Values extends readonly string[]>(values: Values): TSchema {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

const TriggerIdSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description: "Trigger id returned by create_trigger or list_triggers",
});

const EmptySchema = Type.Object({}, { additionalProperties: false });
const TriggerIdInputSchema = Type.Object({ id: TriggerIdSchema }, { additionalProperties: false });

const MainTargetSelectorSchema = Type.Union([
  Type.Object({ kind: Type.Literal("main") }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("subagent"),
    agent: Type.String({ minLength: 1, maxLength: 200, description: "Validated retained subagent id or name" }),
  }, { additionalProperties: false }),
]);

const ChildTargetSelectorSchema = Type.Object({
  kind: Type.Literal("self"),
}, { additionalProperties: false });

function createTriggerSchema(audience: "main" | "subagent") {
  return Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200, description: "Short trigger name" }),
    executable: Type.String({ minLength: 1, maxLength: 4_096, description: "Executable path or program name" }),
    args: Type.Array(Type.String({ maxLength: 16_384 }), {
      maxItems: 256,
      description: "Exact argument vector. Do not join arguments into a shell command.",
    }),
    target: Type.Optional(audience === "main" ? MainTargetSelectorSchema : ChildTargetSelectorSchema),
    template: Type.String({
      minLength: 1,
      maxLength: 64_000,
      description: "Prompt template delivered to the bound target when the trigger fires",
    }),
    mode: StringEnum(["once", "repeat"] as const),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
    lifetimeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 31_536_000_000 })),
    startBehavior: StringEnum(["start", "paused"] as const),
  }, { additionalProperties: false });
}

const InvokeTriggerSchema = Type.Object({
  id: TriggerIdSchema,
  mode: StringEnum(["run", "fire"] as const),
}, { additionalProperties: false });

function resultText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export function requesterTarget(requester: TriggerRequester): TriggerTarget {
  return {
    sessionId: requester.sessionId,
    agentId: requester.kind === "subagent" ? requester.agentId : null,
    label: requester.kind === "subagent" ? requester.agentId : "main",
  };
}

export function targetMatches(requester: TriggerRequester, snapshot: TriggerSnapshot): boolean {
  return snapshot.target.sessionId === requester.sessionId
    && snapshot.target.agentId === (requester.kind === "subagent" ? requester.agentId : null);
}

export function registerTriggerTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  manager: TriggerToolManager,
  resolveRequester: TriggerRequesterResolver,
  options: TriggerToolRegistrationOptions,
): void {
  const requester = async (ctx: ExtensionContext) => {
    const value = await resolveRequester(ctx);
    if (!value.sessionId || !value.cwd
      || !["main", "subagent"].includes(value.kind)
      || (value.kind === "subagent" && !value.agentId)) {
      throw new Error("Trigger requester is incomplete");
    }
    return value;
  };

  const authorizeSnapshot = async (
    owner: TriggerRequester,
    snapshot: TriggerSnapshot,
  ): Promise<TriggerSnapshot> => {
    if (targetMatches(owner, snapshot)) return snapshot;
    if (owner.kind === "main" && await options.authorizeTarget?.(owner, snapshot.target)) {
      return snapshot;
    }
    throw new Error("Trigger manager returned a trigger for a different target");
  };

  const inspectAuthorized = async (
    owner: TriggerRequester,
    id: string,
  ): Promise<TriggerSnapshot> => authorizeSnapshot(owner, await manager.inspect(id, owner));

  const resolveCreateTarget = async (
    owner: TriggerRequester,
    selector: TriggerTargetSelector | undefined,
  ): Promise<{ target: TriggerTarget; cwd: string }> => {
    const requested = selector ?? (owner.kind === "subagent" ? { kind: "self" } : { kind: "main" });
    if (owner.kind === "subagent" && requested.kind !== "self") {
      throw new Error("A child trigger can target only the exact current child");
    }
    if (requested.kind === "self") {
      if (owner.kind !== "subagent") throw new Error("The self target is valid only in a child session");
      return { target: requesterTarget(owner), cwd: owner.cwd };
    }
    if (requested.kind === "main" && owner.kind === "main") {
      return { target: requesterTarget(owner), cwd: owner.cwd };
    }
    if (!options.resolveTarget) throw new Error("The requested trigger target is unavailable");
    return options.resolveTarget(owner, requested);
  };

  pi.registerTool({
    name: "create_trigger",
    label: "Create Trigger",
    description: "Create an executable trigger for this exact session target.",
    promptSnippet: "Create a process trigger for the current agent",
    promptGuidelines: [
      "Pass executable and args separately. Never flatten the argument vector into a shell command.",
      "The tool binds the target from the current session. Do not put session or agent ids in the input.",
    ],
    parameters: createTriggerSchema(options.audience),
    execute: async (_id, input: CreateTriggerToolInput, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      const resolved = await resolveCreateTarget(owner, input.target);
      const { target: _selector, ...parameters } = input;
      const created = await manager.create({ ...parameters, ...resolved }, owner);
      if (created.target.sessionId !== resolved.target.sessionId
        || created.target.agentId !== resolved.target.agentId) {
        throw new Error("Trigger manager created a trigger for a different target");
      }
      return resultText(created);
    },
  });

  pi.registerTool({
    name: "list_triggers",
    label: "List Triggers",
    description: "List triggers owned by this exact session target.",
    parameters: EmptySchema,
    execute: async (_id, _input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      const triggers: TriggerSnapshot[] = [];
      for (const trigger of manager.getTriggers(owner)) {
        try {
          triggers.push(await authorizeSnapshot(owner, trigger));
        } catch {
          // Do not expose a target that the routing adapter cannot validate.
        }
      }
      return resultText(triggers);
    },
  });

  pi.registerTool({
    name: "inspect_trigger",
    label: "Inspect Trigger",
    description: "Inspect one trigger owned by this exact session target.",
    parameters: TriggerIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      return resultText(await inspectAuthorized(owner, input.id));
    },
  });

  pi.registerTool({
    name: "pause_trigger",
    label: "Pause Trigger",
    description: "Pause one trigger owned by this exact session target.",
    parameters: TriggerIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      await inspectAuthorized(owner, input.id);
      return resultText(await authorizeSnapshot(owner, await manager.pause(input.id, owner)));
    },
  });

  pi.registerTool({
    name: "resume_trigger",
    label: "Resume Trigger",
    description: "Resume one trigger owned by this exact session target.",
    promptGuidelines: [
      "Run resume_trigger in a separate tool step because Check mode can require an exact approval.",
    ],
    parameters: TriggerIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      await inspectAuthorized(owner, input.id);
      return resultText(await authorizeSnapshot(owner, await manager.resume(input.id, owner)));
    },
  });

  pi.registerTool({
    name: "cancel_trigger",
    label: "Cancel Trigger",
    description: "Cancel one trigger owned by this exact session target.",
    parameters: TriggerIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      await inspectAuthorized(owner, input.id);
      await manager.cancel(input.id, owner);
      return resultText({ id: input.id, action: "cancelled" });
    },
  });

  pi.registerTool({
    name: "invoke_trigger",
    label: "Invoke Trigger",
    description: "Run the executable now or synthesize one fire event for this target.",
    promptGuidelines: [
      "Run invoke_trigger in a separate tool step because run mode can require an exact approval.",
    ],
    parameters: InvokeTriggerSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      await inspectAuthorized(owner, input.id);
      const result = await manager.invoke(input.id, input.mode as "run" | "fire", owner);
      return resultText(result ?? { id: input.id, action: input.mode });
    },
  });
}

export function triggerToolsExtension(
  manager: TriggerToolManager,
  resolveRequester: TriggerRequesterResolver,
  options: TriggerToolRegistrationOptions,
): InlineExtension {
  return {
    name: "pum-trigger-tools",
    factory(pi) {
      registerTriggerTools(pi, manager, resolveRequester, options);
    },
  };
}
