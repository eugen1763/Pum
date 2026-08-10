import { describe, expect, test } from "bun:test";
import { filterLoginMethods, LoginController } from "./login-controller";
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
  test("filters provider names and useful login metadata", () => {
    const methods = [
      { providerId: "openai", providerName: "OpenAI", authType: "oauth", methodName: "Account", loginLabel: "ChatGPT Plus", canLogin: true },
      { providerId: "local-api", providerName: "Local API", authType: "api_key", methodName: "Environment key", canLogin: false },
    ] as const;
    expect(filterLoginMethods(methods, "chatgpt oauth").map((method) => method.providerId)).toEqual(["openai"]);
    expect(filterLoginMethods(methods, "external credentials").map((method) => method.providerId)).toEqual(["local-api"]);
    expect(filterLoginMethods(methods, "LOCAL api_key").map((method) => method.providerId)).toEqual(["local-api"]);
  });

  test("preserves provider search and selection across the custom child page", () => {
    const pages: LoginPage[] = [];
    const runtime = { getProviders: () => [] } as any;
    const controller = new LoginController(runtime, () => ({}) as any, (page) => pages.push(page), () => {}, () => {});
    controller.open();
    controller.setProviderQuery("custom endpoint");
    expect(pages.at(-1)).toMatchObject({ kind: "providers", query: "custom endpoint", searchFocused: true, customVisible: true });

    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    expect(pages.at(-1)?.kind).toBe("custom-endpoint");
    controller.handleKey({ name: "escape" });
    expect(pages.at(-1)).toMatchObject({ kind: "providers", query: "custom endpoint", cursor: 0, searchFocused: false });
  });

  test("lets the focused input own text keys and uses slash to restore focus", () => {
    const pages: LoginPage[] = [];
    const runtime = { getProviders: () => [] } as any;
    const controller = new LoginController(runtime, () => ({}) as any, (page) => pages.push(page), () => {}, () => {});
    controller.open();
    expect(controller.handleKey({ name: "a", sequence: "a" })).toBe(false);
    controller.handleKey({ name: "down" });
    expect(controller.handleKey({ name: "/", sequence: "/" })).toBe(true);
    expect(pages.at(-1)).toMatchObject({ kind: "providers", searchFocused: true });
  });

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
    controller.handleKey({ name: "down" });
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

  test("shows device details and cancels an OAuth flow without starting a browser process", async () => {
    const pages: LoginPage[] = [];
    const launched: string[] = [];
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
    const controller = new LoginController(
      runtime,
      () => ({}) as any,
      (page) => pages.push(page),
      () => {},
      () => {},
      async (url) => { launched.push(url); return true; },
    );
    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    await settle();
    expect(launched).toEqual(["https://device.test/"]);
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
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    await settle();
    expect(pages.at(-1)?.kind).toBe("error");
    controller.handleKey({ name: "enter" });
    await settle();
    expect(attempts).toBe(2);
  });

  test("retains the provider cursor when child pages return", async () => {
    const pages: LoginPage[] = [];
    const providers = Array.from({ length: 8 }, (_, index) => ({
      id: `provider-${index}`,
      name: `Provider ${index}`,
      auth: { apiKey: { name: "API key", login() {}, resolve() {} } },
    }));
    const runtime = {
      getProviders: () => providers,
      login: async (_id: string, _type: string, interaction: any) => {
        await new Promise((_resolve, reject) => interaction.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
      },
    } as any;
    const controller = new LoginController(runtime, () => ({}) as any, (page) => pages.push(page), () => {}, () => {});
    controller.open();
    controller.handleKey({ name: "down" });

    for (let index = 0; index < providers.length; index++) controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    expect(pages.at(-1)?.kind).toBe("custom-endpoint");
    controller.handleKey({ name: "escape" });
    expect(pages.at(-1)).toMatchObject({ kind: "providers", cursor: providers.length });

    controller.handleKey({ name: "up" });
    controller.handleKey({ name: "enter" });
    await settle();
    expect(pages.at(-1)?.kind).toBe("working");
    controller.handleKey({ name: "escape" });
    await settle();
    expect(pages.at(-1)).toMatchObject({ kind: "providers", cursor: providers.length - 1 });
  });

  test("launches an auth URL once and retains it on an immediate manual-code prompt", async () => {
    const pages: LoginPage[] = [];
    const launched: string[] = [];
    const authEvent = {
      type: "auth_url",
      url: "https://login.example.test/oauth?state=abc",
      instructions: "Open the account login page.",
    } as const;
    const runtime = {
      getProviders: () => [{ id: "oauth", name: "OAuth", auth: { oauth: {
        name: "Account", login() {}, refresh() {}, toAuth() {},
      } } }],
      login: async (_id: string, _type: string, interaction: any) => {
        interaction.notify(authEvent);
        interaction.notify(authEvent);
        await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
      },
    } as any;
    const controller = new LoginController(
      runtime,
      () => ({}) as any,
      (page) => pages.push(page),
      () => {},
      () => {},
      async (url) => { launched.push(url); return false; },
    );

    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    await settle();

    expect(launched).toEqual([authEvent.url]);
    expect(pages.at(-1)).toMatchObject({
      kind: "prompt",
      prompt: { type: "manual_code" },
      event: authEvent,
    });
    controller.handleKey({ name: "escape" });
  });

  test("launches a safe device-code verification URL", async () => {
    const launched: string[] = [];
    const runtime = {
      getProviders: () => [{ id: "oauth", name: "OAuth", auth: { oauth: {
        name: "Account", login() {}, refresh() {}, toAuth() {},
      } } }],
      login: async (_id: string, _type: string, interaction: any) => {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD",
          verificationUri: "https://device.example.test/activate",
        });
        await new Promise((_resolve, reject) => interaction.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
      },
    } as any;
    const controller = new LoginController(
      runtime,
      () => ({}) as any,
      () => {},
      () => {},
      () => {},
      async (url) => { launched.push(url); return true; },
    );

    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    await settle();
    expect(launched).toEqual(["https://device.example.test/activate"]);
    controller.handleKey({ name: "escape" });
  });
});
