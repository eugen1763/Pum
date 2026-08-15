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

/** Count still-queued user messages whose attachments a re-queue would drop. */
function unrestorableQueuedCount(
  pending: readonly PendingLine[],
  steering: readonly string[],
  followUp: readonly string[],
): number {
  const remaining = new Map<string, number>();
  for (const text of [...steering, ...followUp]) {
    remaining.set(text, (remaining.get(text) ?? 0) + 1);
  }
  let unrestorable = 0;
  for (const item of pending) {
    if (item.delivered || item.line.kind !== "text" || item.line.role !== "user" || !item.deliveryText) continue;
    const queued = remaining.get(item.deliveryText) ?? 0;
    if (queued <= 0) continue;
    remaining.set(item.deliveryText, queued - 1);
    if (item.hasAttachments) unrestorable += 1;
  }
  return unrestorable;
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

  // clearQueue returns text only, so re-queuing the survivors rebuilds them
  // without their attachments. Refuse the whole recall instead of dropping
  // another queued message's images.
  const unrestorable = unrestorableQueuedCount(pending, steering, followUp);
  if (unrestorable > 0) {
    throw new Error(
      `cannot recall: it would drop ${unrestorable} queued message`
        + `${unrestorable === 1 ? "" : "s"} that cannot be restored`,
    );
  }

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
