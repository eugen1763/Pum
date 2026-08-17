import { describe, expect, test } from "bun:test";
import { pruneEditedMarkers, reindexMarkers } from "../src/attachment-markers";

const image = { id: 1, marker: "[Image #1]", start: 0, end: 10 };
const pasted = { id: 1, marker: "[Pasted text #1]", start: 0, end: 16 };

describe("pruneEditedMarkers", () => {
  test("keeps a marker that survived the edit and leaves the value alone", () => {
    const result = pruneEditedMarkers([image], {
      previous: "[Image #1] look",
      next: "[Image #1] look here",
      value: "[Image #1] look here",
      cursor: null,
    });

    expect(result.value).toBe("[Image #1] look here");
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([image]);
    expect(result.cursor).toBeNull();
  });

  test("cuts the leftover fragment when the marker itself was edited", () => {
    // Backspace over the closing bracket leaves "[Image #1" in the draft.
    const result = pruneEditedMarkers([image], {
      previous: "[Image #1] look",
      next: "[Image #1 look",
      value: "[Image #1 look",
      cursor: null,
    });

    expect(result.value).toBe(" look");
    expect(result.removed).toEqual([image]);
    expect(result.kept).toEqual([]);
    expect(result.cursor).toBe(0);
  });

  test("reports the earliest cut when chained across two collections", () => {
    const first = pruneEditedMarkers([{ ...image, start: 6, end: 16 }], {
      previous: "keep  [Image #1]",
      next: "keep  [Image #",
      value: "keep  [Image #",
      cursor: null,
    });
    const second = pruneEditedMarkers([{ ...pasted, start: 0, end: 16 }], {
      previous: "keep  [Image #1]",
      next: "keep  [Image #",
      value: first.value,
      cursor: first.cursor,
    });

    expect(second.cursor).toBe(0);
    expect(second.removed).toEqual([{ ...pasted, start: 0, end: 16 }]);
  });
});

describe("reindexMarkers", () => {
  test("moves surviving markers to their new offsets", () => {
    const result = reindexMarkers([{ ...image, start: 0, end: 10 }], "hi [Image #1]");

    expect(result.kept).toEqual([{ ...image, start: 3, end: 13 }]);
    expect(result.removed).toEqual([]);
  });

  test("drops a marker that a later cut removed from the value", () => {
    const result = reindexMarkers([{ ...image, start: 0, end: 10 }], "nothing left");

    expect(result.kept).toEqual([]);
    expect(result.removed).toEqual([{ ...image, start: 0, end: 10 }]);
  });

  test("re-anchors an image after a pasted-text cut shifted it left", () => {
    // The two collections share one running value, so an image indexed before
    // the pasted-text pass must be re-anchored after it, not left stale.
    const afterPastedCut = "[Image #1] tail";

    const result = reindexMarkers([{ ...image, start: 16, end: 26 }], afterPastedCut);

    expect(result.kept).toEqual([{ ...image, start: 0, end: 10 }]);
  });
});
