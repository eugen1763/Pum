import { describe, expect, test } from "bun:test";
import {
  MIN_WINDOW_ROWS,
  REVEAL_MARGIN_ROWS,
  atWindowBottom,
  clampWindowStart,
  extendedWindowStart,
  nearWindowTop,
  tailWindowStart,
  transcriptWindowRows,
  windowStartForRow,
} from "../src/transcript-window";

describe("transcript window size", () => {
  test("keeps two terminal heights of rows, with a floor for a short terminal", () => {
    expect(transcriptWindowRows(40)).toBe(80);
    expect(transcriptWindowRows(100)).toBe(200);
    expect(transcriptWindowRows(10)).toBe(MIN_WINDOW_ROWS);
    expect(transcriptWindowRows(0)).toBe(MIN_WINDOW_ROWS);
  });
});

describe("transcript window start", () => {
  test("stays inside the transcript", () => {
    expect(clampWindowStart(-5, 100)).toBe(0);
    expect(clampWindowStart(500, 100)).toBe(100);
    expect(clampWindowStart(30, 100)).toBe(30);
    expect(clampWindowStart(Number.NaN, 100)).toBe(0);
  });

  test("mounts the whole transcript while it is shorter than one window", () => {
    expect(tailWindowStart(40, 80)).toBe(0);
  });

  test("moves forward with arriving rows while the reader sits at the last row", () => {
    expect(tailWindowStart(1000, 80)).toBe(920);
    expect(tailWindowStart(1010, 80)).toBe(930);
  });

  test("mounts one window whatever the reader asked for earlier", () => {
    // A taller terminal must get the rows to fill itself, so this cannot carry
    // a previous start forward. History the reader asked for is held elsewhere.
    expect(tailWindowStart(1000, 200)).toBe(800);
  });

  test("adds one window of rows per step back", () => {
    expect(extendedWindowStart(920, 80)).toBe(840);
    expect(extendedWindowStart(40, 80)).toBe(0);
    expect(extendedWindowStart(0, 80)).toBe(0);
  });
});

describe("revealing a row", () => {
  test("mounts a row above the window, with rows before it", () => {
    expect(windowStartForRow(900, 400)).toBe(400 - REVEAL_MARGIN_ROWS);
    expect(windowStartForRow(900, 5)).toBe(0);
  });

  test("leaves a mounted row alone rather than dropping history", () => {
    expect(windowStartForRow(100, 900)).toBe(100);
    expect(windowStartForRow(100, 115)).toBe(95);
    expect(windowStartForRow(100, -1)).toBe(100);
  });
});

describe("scroll position tests", () => {
  test("reports the top within one screen of it", () => {
    expect(nearWindowTop(0, 40)).toBe(true);
    expect(nearWindowTop(40, 40)).toBe(true);
    expect(nearWindowTop(41, 40)).toBe(false);
  });

  test("reports the bottom with one row of tolerance", () => {
    expect(atWindowBottom(960, 1000, 40)).toBe(true);
    expect(atWindowBottom(959, 1000, 40)).toBe(true);
    expect(atWindowBottom(958, 1000, 40)).toBe(false);
    // Content shorter than the viewport is always at the bottom.
    expect(atWindowBottom(0, 20, 40)).toBe(true);
  });
});
