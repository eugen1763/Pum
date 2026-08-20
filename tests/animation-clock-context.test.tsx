import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { memo, useState } from "react";
import { AnimationProvider, useClock } from "../src/animation";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

describe("animation clock context", () => {
  test("holds one value while the app around it re-renders", async () => {
    const setup = await createTestRenderer({ width: 24, height: 6 });
    destroy = () => setup.renderer.destroy();

    const sampled: unknown[] = [];
    let memoRenders = 0;
    let bump: (() => void) | undefined;

    /** Re-renders with its parent, so it reports the value it was handed. */
    function Sampler() {
      sampled.push(useClock());
      return <text content="sampler" />;
    }

    /** Only a changed context value can re-render this one. */
    const Consumer = memo(function Consumer() {
      memoRenders += 1;
      useClock();
      return <text content="consumer" />;
    });

    function Host() {
      const [tick, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      return (
        <box style={{ flexDirection: "column" }}>
          <AnimationProvider enabled={false}>
            <text content={`tick ${tick}`} />
            <Sampler />
            <Consumer />
          </AnimationProvider>
        </box>
      );
    }

    createRoot(setup.renderer).render(<Host />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();

    expect(sampled).toHaveLength(1);
    expect(memoRenders).toBe(1);

    bump!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();

    // A fresh object here would be a changed context value, and React answers
    // that by walking the whole tree below the provider and re-rendering every
    // consumer in it. With a long transcript that walk was the largest part of
    // the cost of one keystroke.
    expect(sampled).toHaveLength(2);
    expect(sampled[1]).toBe(sampled[0]);
    expect(memoRenders).toBe(1);
  });
});
