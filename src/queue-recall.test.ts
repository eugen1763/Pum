import { describe, expect, test } from "bun:test";
import { recallNewestQueuedUserMessage } from "./queue-recall";
import type { PendingLine } from "./transcript";

function queuedSession(steering: string[], followUp: string[] = []) {
  let steerQueue = [...steering];
  let followQueue = [...followUp];
  return {
    session: {
      getSteeringMessages: () => steerQueue,
      getFollowUpMessages: () => followQueue,
      clearQueue: () => {
        const cleared = { steering: steerQueue, followUp: followQueue };
        steerQueue = [];
        followQueue = [];
        return cleared;
      },
      steer: async (text: string) => { steerQueue.push(text); },
      followUp: async (text: string) => { followQueue.push(text); },
    } as any,
    queues: () => ({ steering: steerQueue, followUp: followQueue }),
  };
}

const user = (id: string, text: string): PendingLine => ({
  id,
  line: { kind: "text", role: "user", text },
  deliveryText: text,
});

describe("queued user message recall", () => {
  test("recalls newest matching user message and preserves queue order", async () => {
    const queue = queuedSession(["first", "agent event", "second", "second"], ["later"]);
    const recalled = await recallNewestQueuedUserMessage(queue.session, [
      user("first", "first"),
      { id: "agent", line: { kind: "agent-message", sender: "a", recipient: "b", text: "agent event" }, deliveryText: "agent event" },
      user("second-a", "second"),
      user("second-b", "second"),
    ]);

    expect(recalled).toEqual({ id: "second-b", text: "second" });
    expect(queue.queues()).toEqual({
      steering: ["first", "agent event", "second"],
      followUp: ["later"],
    });
  });

  test("does not recall delivered, inter-agent, absent, or non-user messages", async () => {
    const queue = queuedSession(["agent event"]);
    const recalled = await recallNewestQueuedUserMessage(queue.session, [
      { ...user("delivered", "done"), delivered: true },
      { ...user("cache", "cached orchestration"), recallable: false },
      { id: "agent", line: { kind: "agent-message", sender: "a", recipient: "b", text: "agent event" }, deliveryText: "agent event" },
      { id: "system", line: { kind: "text", role: "system", text: "notice" }, deliveryText: "notice" },
    ]);
    expect(recalled).toBeNull();
    expect(queue.queues().steering).toEqual(["agent event"]);
  });

  test("restores all messages when insertion wins the race before clearQueue", async () => {
    const queue = queuedSession(["race"]);
    const originalClear = queue.session.clearQueue;
    queue.session.clearQueue = () => {
      const cleared = originalClear();
      return { ...cleared, steering: [] };
    };
    const recalled = await recallNewestQueuedUserMessage(queue.session, [user("race", "race")]);
    expect(recalled).toBeNull();
    expect(queue.queues().steering).toEqual([]);
  });
});
