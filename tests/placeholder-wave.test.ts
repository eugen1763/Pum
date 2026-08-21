import { describe, expect, test } from "bun:test";
import { placeholderWave } from "../src/animation";
import { hasRunningToolCall, placeholderCrestEnd, promptPlaceholder } from "../src/app";
import { rgba } from "../src/theme";

const BASE = rgba("#565f89");
const HIGHLIGHT = rgba("#c0caf5");
const HINT = " (send to steer)";
const RAISED = /[ᴬ-ᵪʰ-ʸⁿⁱⱽ]/u;

function frame(text: string, elapsedMs: number, lift = true): string {
  const styled = placeholderWave(text, placeholderCrestEnd(text), BASE, HIGHLIGHT, elapsedMs, lift);
  return styled.chunks.map((chunk) => chunk.text).join("");
}

function frames(text: string, lift = true): string[] {
  const seen: string[] = [];
  for (let elapsedMs = 0; elapsedMs < 6000; elapsedMs += 15) seen.push(frame(text, elapsedMs, lift));
  return seen;
}

describe("prompt placeholder", () => {
  test("names what the agent is doing while busy", () => {
    expect(promptPlaceholder({ busy: true, stashOpen: false, toolRunning: true }))
      .toBe(`Working...${HINT}`);
    expect(promptPlaceholder({ busy: true, stashOpen: false }))
      .toBe(`Forming a thought...${HINT}`);
    // A busy subagent view says the same, rather than naming the agent.
    expect(promptPlaceholder({ activeAgentName: "worker", busy: true, stashOpen: false }))
      .toBe(`Forming a thought...${HINT}`);
    expect(promptPlaceholder({ busy: false, stashOpen: false })).toBe("Ask something…");
    expect(promptPlaceholder({ activeAgentName: "worker", busy: false, stashOpen: false }))
      .toBe("Message worker…");
    expect(promptPlaceholder({ busy: false, stashOpen: true })).toBe("Cache…");
  });

  test("finds a running tool call near the end only", () => {
    const running = { kind: "tool", call: { state: "running" } };
    const done = { kind: "tool", call: { state: "ok" } };
    const text = { kind: "text" };
    expect(hasRunningToolCall([text, done, running])).toBe(true);
    expect(hasRunningToolCall([text, running, done])).toBe(true);
    expect(hasRunningToolCall([running, ...Array(30).fill(text)])).toBe(false);
    expect(hasRunningToolCall([text, done])).toBe(false);
    expect(hasRunningToolCall([])).toBe(false);
  });

  test("stops the crest before the steer hint", () => {
    expect(placeholderCrestEnd(`Working...${HINT}`)).toBe("Working...".length);
    expect(placeholderCrestEnd("Ask something…")).toBe("Ask something…".length);
  });
});

describe("placeholder wave", () => {
  const text = `Forming a thought...${HINT}`;

  test("raises one letter at a time and leaves the hint alone", () => {
    const lifted = frames(text).filter((line) => line !== text);
    expect(lifted.length).toBeGreaterThan(5);
    for (const line of lifted) {
      expect([...line].filter((character) => RAISED.test(character))).toHaveLength(1);
      expect(line.endsWith(HINT)).toBe(true);
      expect(line.length).toBe(text.length);
    }
  });

  test("takes twice as long to reach the same early letter", () => {
    expect(frame(text, 400)).toBe(text);
    expect(frame(text, 800)).not.toBe(text);
  });

  test("moves the crest forward, then rests before the next sweep", () => {
    const positions = frames(text)
      .map((line) => [...line].findIndex((character) => RAISED.test(character)))
      .filter((index) => index >= 0);
    expect(positions[0]).toBeLessThan(positions.at(-1)!);
    // The rest between sweeps is most of the cycle, so most frames are plain.
    expect(positions.length).toBeLessThan(frames(text).length / 2);
  });

  test("never swaps a letter that has no raised form of its own", () => {
    // Uppercase F is the one letter in these phrases without a raised form.
    for (const line of frames(text)) expect(line[0]).toBe("F");
  });

  test("colours without lifting when lifting is off", () => {
    for (const line of frames(text, false)) expect(line).toBe(text);
    const styled = placeholderWave(text, placeholderCrestEnd(text), BASE, HIGHLIGHT, 400, false);
    expect(styled.chunks.length).toBeGreaterThan(1);
  });
});
