import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PendingLine } from "./transcript";

export type RecalledQueuedMessage = {
  id: string;
  text: string;
};

function removeNewestOccurrence(values: string[], text: string): string[] | null {
  const index = values.lastIndexOf(text);
  if (index < 0) return null;
  return [...values.slice(0, index), ...values.slice(index + 1)];
}

/** Recall the newest queued user text and preserve all other pi queue entries. */
export async function recallNewestQueuedUserMessage(
  session: AgentSession,
  pending: readonly PendingLine[],
): Promise<RecalledQueuedMessage | null> {
  const steering = [...session.getSteeringMessages()];
  const followUp = [...session.getFollowUpMessages()];
  let candidate: PendingLine | undefined;
  let queue: "steering" | "followUp" | undefined;

  for (let index = pending.length - 1; index >= 0; index--) {
    const item = pending[index]!;
    if (item.delivered || item.recallable === false || item.line.kind !== "text" || item.line.role !== "user" || !item.deliveryText) continue;
    if (steering.includes(item.deliveryText)) {
      candidate = item;
      queue = "steering";
      break;
    }
    if (followUp.includes(item.deliveryText)) {
      candidate = item;
      queue = "followUp";
      break;
    }
  }
  if (!candidate || !queue) return null;

  const cleared = session.clearQueue();
  const remainingSteering = queue === "steering"
    ? removeNewestOccurrence(cleared.steering, candidate.deliveryText!)
    : cleared.steering;
  const remainingFollowUp = queue === "followUp"
    ? removeNewestOccurrence(cleared.followUp, candidate.deliveryText!)
    : cleared.followUp;

  // The message can move into message_start between inspection and clearQueue.
  // In that case, restore every item and report a no-op.
  const recalled = queue === "steering" ? remainingSteering !== null : remainingFollowUp !== null;
  for (const text of remainingSteering ?? cleared.steering) await session.steer(text);
  for (const text of remainingFollowUp ?? cleared.followUp) await session.followUp(text);
  if (!recalled) return null;

  return { id: candidate.id, text: candidate.line.text };
}
