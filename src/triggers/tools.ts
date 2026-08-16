import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_TRIGGER_LIFETIME_MS,
  MIN_TRIGGER_REPEAT_MS,
  type PublicTriggerManager,
  type TriggerRequester,
  type TriggerSnapshot,
  type TriggerTarget,
} from "./types";

export type { TriggerRequester, TriggerSnapshot, TriggerTarget } from "./types";

export type CreateTriggerToolManagerInput = {
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

export type CreateTriggerToolInput = Omit<CreateTriggerToolManagerInput, "target" | "cwd"> & {
  target?: TriggerTargetSelector;
};

export type TriggerToolManager = Pick<PublicTriggerManager,
  "create" | "getTriggers" | "inspect" | "pause" | "resume" | "cancel" | "invoke">;

export type TriggerRuntimeManager = PublicTriggerManager;

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
    restartDelayMs: Type.Optional(Type.Integer({ minimum: MIN_TRIGGER_REPEAT_MS, maximum: 86_400_000 })),
    lifetimeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TRIGGER_LIFETIME_MS })),
    startBehavior: StringEnum(["start", "paused"] as const),
  }, { additionalProperties: false });
}

/** Characters of JSON a trigger tool may put in the model's context. */
const MAX_TRIGGER_RESULT_CHARS = 8_000;

/**
 * A trigger result as text, bounded.
 *
 * A template can be 64,000 characters and a list can hold many triggers, so an
 * unbounded dump of what the model just wrote would crowd the context it needs
 * to act. The details stay complete for the UI and for persistence.
 */
function resultText(value: unknown) {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  const text = json.length <= MAX_TRIGGER_RESULT_CHARS
    ? json
    : `${json.slice(0, MAX_TRIGGER_RESULT_CHARS)}\n… truncated at ${MAX_TRIGGER_RESULT_CHARS.toLocaleString()} characters; inspect_trigger reports one trigger in full`;
  return {
    content: [{ type: "text" as const, text }],
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
  ): Promise<TriggerSnapshot> => authorizeSnapshot(
    owner,
    await manager.inspect(id, owner.kind === "subagent" ? owner : undefined),
  );

  const mutationRequester = (owner: TriggerRequester): TriggerRequester | undefined =>
    owner.kind === "subagent" ? owner : undefined;

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
      for (const trigger of manager.getTriggers(owner.kind === "subagent" ? owner : undefined)) {
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
      return resultText(await authorizeSnapshot(owner, await manager.pause(input.id, mutationRequester(owner))));
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
      return resultText(await authorizeSnapshot(owner, await manager.resume(input.id, mutationRequester(owner))));
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
      await manager.cancel(input.id, mutationRequester(owner));
      return resultText({ id: input.id, action: "cancelled" });
    },
  });

  pi.registerTool({
    name: "invoke_trigger",
    label: "Run Trigger",
    description: "Run the configured executable now.",
    promptGuidelines: [
      "Run invoke_trigger in a separate tool step because it can require an exact approval.",
    ],
    parameters: TriggerIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const owner = await requester(ctx);
      await inspectAuthorized(owner, input.id);
      const result = await manager.invoke(input.id, mutationRequester(owner));
      return resultText(result ?? { id: input.id, action: "run" });
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
