export type OrcaStatusState = "working" | "waiting" | "done";

export type OrcaStatusInput = {
  state: OrcaStatusState;
  model?: string;
  sessionKey?: string;
};

export type OrcaStatusSink = (sequence: string) => void;

type OrcaEnvironment = Record<string, string | undefined>;

const OSC_AGENT_STATUS_PREFIX = "\x1b]9999;";
const OSC_TERMINATOR = "\x07";

export function isOrcaTerminal(environment: OrcaEnvironment): boolean {
  return environment.TERM_PROGRAM?.toLowerCase() === "orca"
    || Boolean(environment.ORCA_PANE_KEY);
}

export function resolveOrcaStatusState(input: {
  working: boolean;
  waitingForUser: boolean;
}): OrcaStatusState {
  if (input.waitingForUser) return "waiting";
  return input.working ? "working" : "done";
}

export function formatOrcaStatus(
  input: Omit<OrcaStatusInput, "sessionKey"> & { sessionBoundary?: boolean },
): string {
  return `${OSC_AGENT_STATUS_PREFIX}${JSON.stringify({
    state: input.state,
    // Orca 1.4 recognizes Pi but does not register a separate PUM identity.
    agentType: "pi",
    ...(input.model ? { model: input.model } : {}),
    ...(input.sessionBoundary ? { sessionBoundary: true } : {}),
  })}${OSC_TERMINATOR}`;
}

/** Best-effort Orca status writer with exact-value deduplication. */
export class OrcaStatusController {
  private lastSequence: string | null = null;
  private activeStatusWritten = false;
  private sessionInitialized = false;
  private sessionKey: string | undefined;

  constructor(
    private readonly enabled: boolean,
    private readonly write: OrcaStatusSink,
  ) {}

  update(input: OrcaStatusInput): boolean {
    if (!this.enabled) return false;

    if (!this.sessionInitialized || input.sessionKey !== this.sessionKey) {
      this.sessionInitialized = true;
      this.sessionKey = input.sessionKey;
      this.lastSequence = null;
      this.activeStatusWritten = false;
    }

    const sequence = formatOrcaStatus({
      state: input.state,
      model: input.model,
      sessionBoundary: input.state === "done" && !this.activeStatusWritten,
    });
    if (sequence === this.lastSequence) return false;

    try {
      this.write(sequence);
      this.lastSequence = sequence;
      if (input.state !== "done") this.activeStatusWritten = true;
      return true;
    } catch {
      // Status reporting must not interrupt the TUI.
      return false;
    }
  }
}
