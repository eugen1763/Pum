import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { companionFileFor, readCompanion, writeCompanion } from "./session-companion";
import { Type } from "typebox";
import { GOAL_VERDICT_TOOL_NAME } from "./goal-judge";
import { TODO_TOOL_NAMES } from "./todo-tools";
import { AFK_ANSWER_TOOL_NAME } from "./afk-delegate";
import { CONTEXT_TOOL_NAMES } from "./context-window";

/**
 * Always-present tool that reveals hidden tool groups in this thread.
 *
 * Revealing is one-way. A group stays enabled for the rest of the session, and
 * there is no tool to hide one again: a thread that has seen a tool may have
 * planned around it, and taking it back mid-task would strand that plan.
 *
 * PUM does not send every custom tool schema on every request any more. The
 * core tools are always sent. Optional tools live in hidden groups. Calling
 * `enable_tools` with a group name starts sending that group's real tool
 * schemas from the next request onward. Hidden groups are completely absent
 * from the model tool list until they are enabled.
 */
export const ENABLE_TOOLS = "enable_tools";

/** Companion suffix for this session's enabled groups. */
const TOOL_GROUPS_SUFFIX = "tool-groups.json";

/**
 * Tools that are always sent in every session.
 *
 * The pi built-ins (read, write, edit, bash) must never be filtered.
 * Questionnaire, project-memory reads, and own-session context tools stay present too.
 */
export const CORE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "questionnaire",
  "memory_read",
  ...CONTEXT_TOOL_NAMES,
] as const;

/** Extra always-sent tool that only the authoritative main agent may use. */
export const MAIN_EXTRA_TOOL_NAMES = ["memory_edit"] as const;

/** Extra always-sent tools that exist only in child (subagent) sessions. */
export const CHILD_EXTRA_TOOL_NAMES = ["finish_subagent"] as const;

/**
 * A goal judge reads the repository and reports one verdict. It gets no
 * mutation tool, no delegation tool, and no way to message another agent.
 */
export const JUDGE_TOOL_NAMES = ["read", "bash", GOAL_VERDICT_TOOL_NAME] as const;

/**
 * Tools kept out of a readonly child's schemas.
 *
 * Most of them mutate, or start work that mutates. The read-only shell tools
 * are here for a different reason: a managed shell is a side channel a readonly
 * child has no business reading, and offering half the group would only invite
 * calls the guard refuses. `src/subagents/readonly.ts` enforces the same set at
 * call time, and a test holds the two lists together.
 */
export const READONLY_CHILD_OMITTED_TOOL_NAMES = [
  "write",
  "edit",
  "spawn_subagent",
  "message_agent",
  "create_trigger",
  "resume_trigger",
  "invoke_trigger",
  "message_cache_add",
  "message_cache_delete",
  "message_cache_send",
  "start_shell",
  "list_shells",
  "inspect_shell",
  "get_shell_output",
  "kill_shell",
] as const;

/**
 * Admin group: all trigger tools plus all message-cache tools.
 */
export const ADMIN_GROUP_TOOL_NAMES = [
  "create_trigger",
  "list_triggers",
  "inspect_trigger",
  "pause_trigger",
  "resume_trigger",
  "cancel_trigger",
  "invoke_trigger",
  "message_cache_list",
  "message_cache_read",
  "message_cache_add",
  "message_cache_delete",
  "message_cache_send",
] as const;

/**
 * Subagents group. `finish_subagent` is deliberately excluded: a child must
 * always be able to complete itself, so it stays in the child core set.
 */
export const SUBAGENTS_GROUP_TOOL_NAMES = [
  "spawn_subagent",
  "message_agent",
  "list_subagents",
  "stop_subagent",
] as const;

/** Worktree group. */
export const WORKTREE_GROUP_TOOL_NAMES = ["worktree"] as const;

/** Managed background shell group. Readonly children omit the complete group. */
export const SHELLS_GROUP_TOOL_NAMES = [
  "start_shell",
  "list_shells",
  "inspect_shell",
  "get_shell_output",
  "kill_shell",
] as const;

/**
 * The hidden groups. There is no News group because PUM has no news model
 * tool (news.ts is a UI-only feature), so that group would contain zero tools.
 */
export const TOOL_GROUP_NAMES = ["Admin", "Subagents", "Worktree", "Shells", "Todo"] as const;

export type ToolGroupName = (typeof TOOL_GROUP_NAMES)[number];

export type ToolGroupAudience = "main" | "subagent";

export interface ToolGroupDefinition {
  label: string;
  toolNames: readonly string[];
}

/** Group name to the tools it contains. */
export const TOOL_GROUPS: Readonly<Record<ToolGroupName, ToolGroupDefinition>> = {
  Admin: { label: "Admin", toolNames: ADMIN_GROUP_TOOL_NAMES },
  Subagents: { label: "Subagents", toolNames: SUBAGENTS_GROUP_TOOL_NAMES },
  Worktree: { label: "Worktree", toolNames: WORKTREE_GROUP_TOOL_NAMES },
  Shells: { label: "Shells", toolNames: SHELLS_GROUP_TOOL_NAMES },
  Todo: { label: "Todo", toolNames: TODO_TOOL_NAMES },
};

/** Union of every optional tool name across all hidden groups. */
export const ALL_GROUP_TOOL_NAMES: readonly string[] = [
  ...ADMIN_GROUP_TOOL_NAMES,
  ...SUBAGENTS_GROUP_TOOL_NAMES,
  ...WORKTREE_GROUP_TOOL_NAMES,
  ...SHELLS_GROUP_TOOL_NAMES,
  ...TODO_TOOL_NAMES,
];

/** The tool names a session of an audience may expose (the allowlist). */
export function mainAllowedToolNames(): string[] {
  return [...CORE_TOOL_NAMES, ...MAIN_EXTRA_TOOL_NAMES, ENABLE_TOOLS, ...ALL_GROUP_TOOL_NAMES];
}

/** The complete tool list of a goal judge session. */
/** An AFK delegate holds one tool. No files, no shell, no network, no delegation. */
export const AFK_TOOL_NAMES = [AFK_ANSWER_TOOL_NAME] as const;

export function afkAllowedToolNames(): string[] {
  return [...AFK_TOOL_NAMES];
}

export function judgeAllowedToolNames(): string[] {
  return [...JUDGE_TOOL_NAMES];
}

/** The child session allowlist adds the child-only core tool. */
export function childAllowedToolNames(readonly = false): string[] {
  const names = [
    ...CORE_TOOL_NAMES,
    ...CHILD_EXTRA_TOOL_NAMES,
    ENABLE_TOOLS,
    ...ALL_GROUP_TOOL_NAMES,
  ];
  if (!readonly) return names;
  const omitted = new Set<string>(READONLY_CHILD_OMITTED_TOOL_NAMES);
  return names.filter((name) => !omitted.has(name));
}

/** Tool names inside one group, or an empty list for an unknown group. */
export function toolNamesInGroup(group: string): readonly string[] {
  return TOOL_GROUPS[group as ToolGroupName]?.toolNames ?? [];
}

/** Group names that are not currently enabled. */
export function hiddenGroupNames(enabled: readonly string[]): string[] {
  const enabledSet = new Set(enabled);
  return TOOL_GROUP_NAMES.filter((name) => !enabledSet.has(name));
}

/**
 * The outgoing tool list for a session with the given enabled groups.
 *
 * Core tools and `enable_tools` are always present. Child sessions add the
 * child-only core tools. Enabled groups contribute their real tools. The audience
 * allowlist defines the canonical order, independent of activation or restore order.
 */
export function activeToolNames(
  enabledGroups: Iterable<string>,
  audience: ToolGroupAudience,
  readonly = false,
): string[] {
  const active = new Set<string>([...CORE_TOOL_NAMES, ENABLE_TOOLS]);
  if (audience === "main") {
    for (const name of MAIN_EXTRA_TOOL_NAMES) active.add(name);
  }
  if (audience === "subagent") {
    for (const name of CHILD_EXTRA_TOOL_NAMES) active.add(name);
  }
  for (const group of enabledGroups) {
    for (const name of toolNamesInGroup(group)) active.add(name);
  }
  const allowed = audience === "main" ? mainAllowedToolNames() : childAllowedToolNames(readonly);
  return allowed.filter((name) => active.has(name));
}

const isGroupName = (value: unknown): value is ToolGroupName =>
  typeof value === "string" && (TOOL_GROUP_NAMES as readonly string[]).includes(value);

/** Companion file next to the session JSONL: `<session>.tool-groups.json` */
export function toolGroupsFileFor(sessionFile: string): string {
  return companionFileFor(sessionFile, TOOL_GROUPS_SUFFIX);
}

/** Accepts both the current array form and the older `{ groups: [...] }` form. */
function isStoredGroups(value: unknown): value is unknown[] | { groups: unknown[] } {
  return Array.isArray(value) || Array.isArray((value as { groups?: unknown })?.groups);
}

/** Load the enabled groups persisted for a session. Never throws. */
export function loadToolGroups(sessionFile: string | undefined): ToolGroupName[] {
  const stored = readCompanion(sessionFile, TOOL_GROUPS_SUFFIX, isStoredGroups, []);
  const groups: unknown[] = Array.isArray(stored) ? stored : stored.groups;
  return [...new Set(groups.filter(isGroupName))].sort();
}

/** Persist the enabled groups atomically next to the session. Best effort only. */
export function saveToolGroups(
  sessionFile: string | undefined,
  groups: readonly ToolGroupName[],
): void {
  writeCompanion(sessionFile, TOOL_GROUPS_SUFFIX, [...new Set(groups)].sort());
}

/** Human-readable state used as the result text of enable_tools. */
export function describeToolGroups(enabled: readonly string[]): string {
  const hidden = hiddenGroupNames(enabled);
  const enabledLine = enabled.length > 0 ? enabled.join(", ") : "(none)";
  const hiddenLine = hidden.length > 0 ? hidden.join(", ") : "(none)";
  return [
    `Enabled tool groups: ${enabledLine}`,
    `Hidden tool groups: ${hiddenLine}`,
  ].join("\n");
}

function buildEnableToolsDescription(controller: ToolGroupsController): string {
  const always = activeToolNames([], controller.audience, controller.isReadonly);
  const lines = [
    "Reveal one or more hidden tool groups in this thread. The real tool schemas of a revealed group start being sent from the next request onward.",
    "",
    "Always-present tools: " + always.join(", "),
    "Hidden groups:",
  ];
  for (const name of TOOL_GROUP_NAMES) {
    const available = controller.availableToolNames(TOOL_GROUPS[name].toolNames);
    if (available.length > 0) lines.push(`- ${name}: ${available.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Per-session enabled-group state for one agent (main or subagent).
 *
 * Each agent session tracks its own groups independently. The state persists
 * in a companion file next to the session JSONL (same pattern as the news
 * companion file), so it survives resume and never enters the LLM context.
 */
export class ToolGroupsController {
  readonly audience: ToolGroupAudience;
  readonly isReadonly: boolean;
  private enabled = new Set<ToolGroupName>();
  private file: string | undefined;

  constructor(audience: ToolGroupAudience, sessionFile?: string, isReadonly = false) {
    this.audience = audience;
    this.file = sessionFile;
    this.isReadonly = audience === "subagent" && isReadonly;
  }

  /** The companion file currently bound, if any. */
  get sessionFile(): string | undefined {
    return this.file;
  }

  /** Read the persisted groups for a session into this controller. */
  load(sessionFile?: string): void {
    if (sessionFile !== undefined) this.file = sessionFile;
    this.enabled = new Set(loadToolGroups(this.file));
  }

  /** The enabled group names, sorted. */
  enabledGroups(): ToolGroupName[] {
    return [...this.enabled].sort();
  }

  /** The outgoing tool list for this controller's current state. */
  activeTools(): string[] {
    return activeToolNames(this.enabled, this.audience, this.isReadonly);
  }

  availableToolNames(names: readonly string[]): string[] {
    if (!this.isReadonly) return [...names];
    const omitted = new Set<string>(READONLY_CHILD_OMITTED_TOOL_NAMES);
    return names.filter((name) => !omitted.has(name));
  }

  /** Enable one group, persist, and report the resulting state. */
  enableGroup(group: string): void {
    if (!isGroupName(group)) {
      throw new Error(
        `Unknown tool group: ${group}\nAvailable groups: ${TOOL_GROUP_NAMES.join(", ")}`,
      );
    }
    this.enabled.add(group);
    saveToolGroups(this.file, this.enabledGroups());
  }

  /** Text that reports enabled and hidden groups. */
  describe(): string {
    return describeToolGroups(this.enabledGroups());
  }

  /**
   * Register `enable_tools` against a session API.
   *
   * The execute callback calls `pi.setActiveTools` so the change applies from
   * the next request onward on exactly this session.
   */
  registerTool(pi: Pick<ExtensionAPI, "registerTool" | "setActiveTools">): void {
    const controller = this;
    pi.registerTool({
      name: ENABLE_TOOLS,
      label: "Enable Tools",
      description: buildEnableToolsDescription(controller),
      parameters: Type.Object(
        {
          groups: Type.Array(
            Type.Union(TOOL_GROUP_NAMES.map((name) => Type.Literal(name))),
            {
              minItems: 1,
              maxItems: TOOL_GROUP_NAMES.length,
              description: "Tool groups to reveal in this thread",
            },
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        for (const group of params.groups) controller.enableGroup(group);
        pi.setActiveTools(controller.activeTools());
        const enabled = controller.enabledGroups();
        return {
          content: [{ type: "text" as const, text: controller.describe() }],
          details: { enabled, hidden: hiddenGroupNames(enabled) },
        };
      },
    });
  }

  /** The inline extension that registers `enable_tools` for one session. */
  extension(): InlineExtension {
    return {
      name: `pum-tool-groups-${this.audience}`,
      factory: (pi) => this.registerTool(pi),
    };
  }
}
