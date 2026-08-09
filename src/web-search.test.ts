import { describe, expect, test } from "bun:test";
import { SearchCallRouter } from "./web-search";

describe("web search routing", () => {
  test("delivers calls only to the matching session route", () => {
    const router = new SearchCallRouter();
    const main: string[] = [];
    const child: string[] = [];
    router.subscribe("main-session", (call) => main.push(call.id));
    router.subscribe("child-session", (call) => child.push(call.id));

    router.emit("child-session", { phase: "start", id: "child-search", query: "child" });
    router.emit("main-session", { phase: "start", id: "main-search", query: "main" });

    expect(main).toEqual(["main-search"]);
    expect(child).toEqual(["child-search"]);
  });
});
