/** Synthetic-window guidance only; callers supply actual active tools and memory injection capability. */
export function contextRecoveryGuidance(activeToolNames: readonly string[], memoryInjected: boolean): string {
  const active = new Set(activeToolNames);
  const guidance = [
    "Continue from the literal handoff and supplied context; no routine restoration is required. Current system instructions still apply.",
  ];
  if (memoryInjected) {
    guidance.push("Project memory is automatically injected. Use the supplied snapshot; do not reread it unless genuinely needed. Respect empty, unavailable, or withdrawn memory notices; they do not restore older facts.");
  } else if (active.has("memory_read")) {
    guidance.push("Use memory_read only if relevant project facts are missing from the supplied context.");
  }
  if (active.has("todo_list")) {
    guidance.push("Use todo_list only if missing task state is needed to continue; the handoff may already be sufficient.");
  } else {
    guidance.push("Do not enable hidden todo tools solely for recovery; the handoff and supplied context may be sufficient.");
  }
  if (active.has("history")) {
    guidance.push("Use history selectively only for missing relevant instructions or results; do not reload the old transcript wholesale.");
  }
  guidance.push("Verify live state before repeating completed external actions.");
  return guidance.join("\n");
}
