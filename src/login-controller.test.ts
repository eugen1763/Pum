import { describe, expect, test } from "bun:test";
import { LoginController } from "./login-controller";
import type { LoginPage } from "./login-popup";

const model = {
  id: "model-a", name: "Model A", provider: "api", api: "openai-completions",
  baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("login controller", () => {
  test("moves an API-key login through prompt, storage, refresh, and selection", async () => {
    let submitted = "";
    const pages: LoginPage[] = [];
    const selected: string[] = [];
    const runtime = {
      getProviders: () => [{ id: "api", name: "API", auth: { apiKey: {
        name: "API key", login() {}, resolve() {},
      } } }],
      login: async (_id: string, _type: string, interaction: any) => {
        submitted = await interaction.prompt({ type: "secret", message: "Enter API key" });
      },
      refresh: async () => ({ aborted: false, errors: new Map() }),
      getAvailableSnapshot: () => [model],
    } as any;
    const controller = new LoginController(
      runtime,
      () => ({ setModel: async (next: any) => { selected.push(next.id); } }) as any,
      (page) => pages.push(page),
      () => {},
      () => {},
    );
    controller.open();
    controller.handleKey({ name: "enter" });
    await settle();
    expect(pages.at(-1)?.kind).toBe("prompt");
    for (const character of "secret-value") controller.handleKey({ name: character, sequence: character });
    expect(JSON.stringify(pages.at(-1))).not.toContain("secret-value");
    controller.handleKey({ name: "enter" });
    await settle();
    await settle();
    expect(submitted).toBe("secret-value");
    expect(selected).toEqual(["model-a"]);
    expect(pages.at(-1)?.kind).toBe("success");
  });

  test("shows device details and cancels an OAuth flow", async () => {
    const pages: LoginPage[] = [];
    let aborted = false;
    const runtime = {
      getProviders: () => [{ id: "oauth", name: "OAuth", auth: { oauth: {
        name: "Account", login() {}, refresh() {}, toAuth() {},
      } } }],
      login: async (_id: string, _type: string, interaction: any) => {
        interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://device.test" });
        await new Promise((_resolve, reject) => interaction.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        }));
      },
    } as any;
    const controller = new LoginController(runtime, () => ({}) as any, (page) => pages.push(page), () => {}, () => {});
    controller.open();
    controller.handleKey({ name: "enter" });
    await settle();
    expect(pages.at(-1)).toMatchObject({ kind: "working", event: { type: "device_code", userCode: "ABCD" } });
    controller.handleKey({ name: "escape" });
    await settle();
    expect(aborted).toBe(true);
    expect(pages.at(-1)?.kind).toBe("providers");
  });

  test("keeps a retry action after an error", async () => {
    const pages: LoginPage[] = [];
    let attempts = 0;
    const runtime = {
      getProviders: () => [{ id: "api", name: "API", auth: { apiKey: { name: "API key", login() {}, resolve() {} } } }],
      login: async () => { attempts++; throw new Error("temporary failure"); },
    } as any;
    const controller = new LoginController(runtime, () => ({}) as any, (page) => pages.push(page), () => {}, () => {});
    controller.open();
    controller.handleKey({ name: "enter" });
    await settle();
    expect(pages.at(-1)?.kind).toBe("error");
    controller.handleKey({ name: "enter" });
    await settle();
    expect(attempts).toBe(2);
  });
});
