import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DEFAULT_SHELL_OUTPUT_LINES = 200;
export const DEFAULT_SHELL_WAIT_TIMEOUT_MS = 30_000;
export const MAX_SHELL_WAIT_TIMEOUT_MS = 120_000;
export const MAX_SHELL_WAIT_PATTERN_LENGTH = 4_096;

export type ShellRequester =
  | { kind: "main"; sessionId: string; cwd: string }
  | { kind: "subagent"; sessionId: string; agentId: string; cwd: string };

export type ShellOwner = {
  sessionId: string;
  agentId: string | null;
  label: string;
};

export type ShellTargetSelector =
  | { kind: "main" }
  | { kind: "subagent"; agent: string };

export type ShellState = "starting" | "running" | "exited" | "killed" | "failed" | "unavailable";

export type ShellSnapshot = {
  id: string;
  name: string;
  owner: ShellOwner;
  state: ShellState | string;
  executable: string;
  args: string[];
  cwd: string;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  output: {
    path: string;
    bytes: number;
    truncated: boolean;
    exists?: boolean;
  };
};

export type StartShellManagerInput = {
  name?: string;
  executable: string;
  args: string[];
  cwd: string;
  projectCwd: string;
  env?: Readonly<Record<string, string>>;
  owner: ShellOwner;
};

export type GetShellOutputInput = {
  lineLimit: number;
  waitPattern?: string;
  timeoutMs: number;
};

export type ShellOutputResult = {
  shell: ShellSnapshot;
  tail: string;
  matchingLines?: string[];
  matched?: boolean;
  timedOut?: boolean;
};

/** The narrow manager surface used by model tools. */
export type ShellToolManager = {
  create(input: StartShellManagerInput): Promise<ShellSnapshot>;
  list(owner?: ShellOwner): ShellSnapshot[];
  inspect(id: string, owner?: ShellOwner): ShellSnapshot | Promise<ShellSnapshot>;
  getOutput(
    id: string,
    input: GetShellOutputInput,
    owner?: ShellOwner,
  ): ShellOutputResult | Promise<ShellOutputResult>;
  terminate(id: string, owner?: ShellOwner): ShellSnapshot | Promise<ShellSnapshot>;
};

export type ShellRequesterResolver = (
  context: ExtensionContext,
) => ShellRequester | Promise<ShellRequester>;

export type ShellOwnerResolver = (
  requester: ShellRequester,
  selector: ShellTargetSelector,
) => { owner: ShellOwner; cwd: string } | Promise<{ owner: ShellOwner; cwd: string }>;

export type ShellToolRegistrationOptions = {
  audience: "main" | "subagent";
  resolveOwner?: ShellOwnerResolver;
  authorizeOwner?: (
    requester: ShellRequester,
    owner: ShellOwner,
  ) => boolean | Promise<boolean>;
};

const ShellIdSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description: "Shell id returned by start_shell or list_shells",
});

const EnvironmentSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 512 }),
  Type.String({ maxLength: 32_768 }),
  {
    description: "Explicit environment additions. PUM refuses PATH and any variable that can inject"
      + " runtime behavior, such as LD_PRELOAD, GIT_SSH_COMMAND, GIT_CONFIG_*, BASH_ENV, or PAGER.",
  },
);

const MainTargetSelectorSchema = Type.Union([
  Type.Object({ kind: Type.Literal("main") }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("subagent"),
    agent: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Validated retained subagent id or name",
    }),
  }, { additionalProperties: false }),
]);

const EmptySchema = Type.Object({}, { additionalProperties: false });
const ShellIdInputSchema = Type.Object({ id: ShellIdSchema }, { additionalProperties: false });

function startShellSchema() {
  return Type.Object({
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Short process name" })),
    executable: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description: "Executable path or program name",
    }),
    args: Type.Array(Type.String({ maxLength: 16_384 }), {
      maxItems: 256,
      description: "Exact argument vector. Do not join arguments into a shell command.",
    }),
    cwd: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 4_096,
      description: "Working directory. Defaults to the owning agent worktree.",
    })),
    env: Type.Optional(EnvironmentSchema),
  }, { additionalProperties: false });
}

function listShellsSchema(audience: "main" | "subagent") {
  if (audience === "subagent") return EmptySchema;
  return Type.Object({
    target: Type.Optional(MainTargetSelectorSchema),
  }, { additionalProperties: false });
}

const GetShellOutputSchema = Type.Object({
  id: ShellIdSchema,
  lineLimit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: DEFAULT_SHELL_OUTPUT_LINES,
    description: "Number of recent logical lines. Defaults to 200.",
  })),
  waitPattern: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_SHELL_WAIT_PATTERN_LENGTH,
    description: "Bounded regular expression used for an event-driven readiness wait",
  })),
  timeoutMs: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_SHELL_WAIT_TIMEOUT_MS,
    description: "Readiness wait timeout. Defaults to 30000ms.",
  })),
}, { additionalProperties: false });

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export function requesterOwner(requester: ShellRequester): ShellOwner {
  return {
    sessionId: requester.sessionId,
    agentId: requester.kind === "subagent" ? requester.agentId : null,
    label: requester.kind === "subagent" ? requester.agentId : "main",
  };
}

export function ownerMatches(requester: ShellRequester, snapshot: ShellSnapshot): boolean {
  return snapshot.owner.sessionId === requester.sessionId
    && snapshot.owner.agentId === (requester.kind === "subagent" ? requester.agentId : null);
}

export function registerShellTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  manager: ShellToolManager,
  resolveRequester: ShellRequesterResolver,
  options: ShellToolRegistrationOptions,
): void {
  const requester = async (ctx: ExtensionContext): Promise<ShellRequester> => {
    const value = await resolveRequester(ctx);
    if (!value.sessionId || !value.cwd
      || !["main", "subagent"].includes(value.kind)
      || (value.kind === "subagent" && !value.agentId)) {
      throw new Error("Shell requester is incomplete");
    }
    return value;
  };

  const authorizeSnapshot = async (
    actor: ShellRequester,
    snapshot: ShellSnapshot,
  ): Promise<ShellSnapshot> => {
    if (ownerMatches(actor, snapshot)) return snapshot;
    if (actor.kind === "main" && await options.authorizeOwner?.(actor, snapshot.owner)) {
      return snapshot;
    }
    throw new Error("Shell manager returned a shell for a different owner");
  };

  const ownerFilter = (actor: ShellRequester): ShellOwner | undefined =>
    actor.kind === "subagent" ? requesterOwner(actor) : undefined;

  const inspectAuthorized = async (actor: ShellRequester, id: string): Promise<ShellSnapshot> =>
    authorizeSnapshot(actor, await manager.inspect(id, ownerFilter(actor)));

  const resolveListOwner = async (
    actor: ShellRequester,
    selector: ShellTargetSelector | undefined,
  ): Promise<ShellOwner | undefined> => {
    if (!selector) return undefined;
    if (selector.kind === "main") {
      if (actor.kind !== "main") throw new Error("A child can list only its own shells");
      return requesterOwner(actor);
    }
    if (actor.kind !== "main" || !options.resolveOwner) {
      throw new Error("The requested shell owner is unavailable");
    }
    return (await options.resolveOwner(actor, selector)).owner;
  };

  pi.registerTool({
    name: "start_shell",
    label: "Start Shell",
    description: "Start a supervised background process owned by this exact agent.",
    promptSnippet: "Start a supervised background process for the current agent",
    promptGuidelines: [
      "Pass executable and args separately. Never flatten the argument vector into a shell command.",
      "Run start_shell in a separate tool step because Check mode can require an exact decision.",
      "Do not put session or agent ids in the input. PUM binds the exact current owner.",
    ],
    executionMode: "sequential",
    parameters: startShellSchema(),
    execute: async (_id, input, _signal, _update, ctx) => {
      const actor = await requester(ctx);
      const owner = requesterOwner(actor);
      const shell = await manager.create({
        name: input.name,
        executable: input.executable,
        args: [...input.args],
        cwd: input.cwd ?? actor.cwd,
        projectCwd: actor.cwd,
        env: input.env,
        owner,
      });
      if (shell.owner.sessionId !== owner.sessionId || shell.owner.agentId !== owner.agentId) {
        throw new Error("Shell manager created a shell for a different owner");
      }
      return result(shell);
    },
  });

  pi.registerTool({
    name: "list_shells",
    label: "List Shells",
    description: options.audience === "main"
      ? "List managed shells owned by main or retained subagents."
      : "List managed shells owned by this exact subagent.",
    parameters: listShellsSchema(options.audience),
    execute: async (_id, input: { target?: ShellTargetSelector }, _signal, _update, ctx) => {
      const actor = await requester(ctx);
      const selectedOwner = await resolveListOwner(actor, input.target);
      const shells: ShellSnapshot[] = [];
      for (const shell of manager.list(ownerFilter(actor))) {
        if (selectedOwner
          && (shell.owner.sessionId !== selectedOwner.sessionId
            || shell.owner.agentId !== selectedOwner.agentId)) continue;
        try {
          shells.push(await authorizeSnapshot(actor, shell));
        } catch {
          // Do not expose an owner that the retained-agent adapter cannot validate.
        }
      }
      return result(shells);
    },
  });

  pi.registerTool({
    name: "inspect_shell",
    label: "Inspect Shell",
    description: "Inspect one authorized managed shell.",
    parameters: ShellIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const actor = await requester(ctx);
      return result(await inspectAuthorized(actor, input.id));
    },
  });

  pi.registerTool({
    name: "get_shell_output",
    label: "Get Shell Output",
    description: "Read a recent output tail or wait for a bounded readiness pattern.",
    parameters: GetShellOutputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const actor = await requester(ctx);
      await inspectAuthorized(actor, input.id);
      const output = await manager.getOutput(input.id, {
        lineLimit: input.lineLimit ?? DEFAULT_SHELL_OUTPUT_LINES,
        waitPattern: input.waitPattern,
        timeoutMs: input.timeoutMs ?? DEFAULT_SHELL_WAIT_TIMEOUT_MS,
      }, ownerFilter(actor));
      await authorizeSnapshot(actor, output.shell);
      return result(output);
    },
  });

  pi.registerTool({
    name: "kill_shell",
    label: "Kill Shell",
    description: "Terminate one authorized managed shell process tree.",
    parameters: ShellIdInputSchema,
    execute: async (_id, input, _signal, _update, ctx) => {
      const actor = await requester(ctx);
      await inspectAuthorized(actor, input.id);
      return result(await authorizeSnapshot(
        actor,
        await manager.terminate(input.id, ownerFilter(actor)),
      ));
    },
  });
}

export function shellToolsExtension(
  manager: ShellToolManager,
  resolveRequester: ShellRequesterResolver,
  options: ShellToolRegistrationOptions,
): InlineExtension {
  return {
    name: "pum-shell-tools",
    factory(pi) {
      registerShellTools(pi, manager, resolveRequester, options);
    },
  };
}
