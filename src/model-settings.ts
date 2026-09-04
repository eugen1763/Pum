import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Promote main-session defaults without switching models or resetting effort.
 * Call only for explicit global promotion, never for startup or child setup.
 */
export async function saveMainModelDefaults(session: Pick<AgentSession, "agent" | "settingsManager">): Promise<void> {
  const { model, thinkingLevel } = session.agent.state;
  if (model) session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
  session.settingsManager.setDefaultThinkingLevel(thinkingLevel);
  await session.settingsManager.flush();
  // pi records write failures instead of rejecting flush(). Do not report a
  // successful promotion when those writes failed.
  const errors = session.settingsManager.drainErrors();
  if (errors.length > 0) throw new Error(errors.map(({ error }) => error.message).join("; "));
}
