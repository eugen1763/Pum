import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterLoginMethods, LoginController } from "./login-controller";
import type { LoginPage } from "./login-popup";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  test("pastes provider secrets without exposing them in pages, entries, or errors", async () => {
    const pages: LoginPage[] = [];
    const entries: unknown[] = [];
    let submitted = "";
    const runtime = {
      getProviders: () => [{ id: "api", name: "API", auth: { apiKey: { name: "API key", login() {}, resolve() {} } } }],
      login: async (_id: string, _type: string, interaction: any) => {
        submitted = await interaction.prompt({ type: "secret", message: "Enter API key" });
        throw new Error(`Rejected ${submitted}`);
      },
    } as any;
    const controller = new LoginController(
      runtime,
      () => ({ sessionManager: { getEntries: () => entries } }) as any,
      (page) => pages.push(page),
      () => {},
      () => {},
    );
    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    await settle();

    const key = "pasted-test-key";
    expect(controller.acceptsTextPaste()).toBe(true);
    expect(controller.pasteText(`${key}\r\n`)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ kind: "prompt", secretLength: key.length });
    expect(JSON.stringify(pages)).not.toContain(key);
    controller.handleKey({ name: "enter" });
    await settle();
    expect(submitted).toBe(key);
    expect(entries).toEqual([]);
    expect(pages.at(-1)).toMatchObject({ kind: "error" });
    expect(JSON.stringify(pages)).not.toContain(key);
    expect((pages.at(-1) as Extract<LoginPage, { kind: "error" }>).message).toContain("[redacted]");
  });

  test("pastes a custom endpoint and masks a custom API key", () => {
    const pages: LoginPage[] = [];
    const controller = new LoginController({ getProviders: () => [] } as any, () => ({}) as any, (page) => pages.push(page), () => {}, () => {});
    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    expect(controller.pasteText("https://local.example.test/v1\r\n")).toBe(true);
    expect(pages.at(-1)).toMatchObject({ kind: "custom-endpoint", endpoint: "https://local.example.test/v1" });
    controller.handleKey({ name: "enter" });

    const key = "custom-pasted-key";
    expect(controller.pasteText(key)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ kind: "custom-key", secretLength: key.length });
    expect(JSON.stringify(pages)).not.toContain(key);
  });

  test("supports cursor editing and paste insertion in custom fields", () => {
    const pages: LoginPage[] = [];
    const controller = new LoginController(
      { getProviders: () => [] } as any,
      () => ({}) as any,
      (page) => pages.push(page),
      () => {},
      () => {},
    );
    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });

    for (const character of "ac") controller.handleKey({ name: character, sequence: character });
    controller.handleKey({ name: "left" });
    controller.handleKey({ name: "b", sequence: "b" });
    expect(pages.at(-1)).toMatchObject({ kind: "custom-endpoint", endpoint: "abc", cursor: 2 });

    controller.handleKey({ name: "home" });
    controller.handleKey({ name: "delete" });
    expect(controller.pasteText("https://")).toBe(true);
    controller.handleKey({ name: "end" });
    controller.handleKey({ name: "backspace" });
    expect(pages.at(-1)).toMatchObject({
      kind: "custom-endpoint",
      endpoint: "https://b",
      cursor: "https://b".length,
    });

    controller.handleKey({ name: "enter" });
    for (const character of "acd") controller.handleKey({ name: character, sequence: character });
    controller.handleKey({ name: "home" });
    controller.handleKey({ name: "right" });
    expect(controller.pasteText("b")).toBe(true);
    controller.handleKey({ name: "delete" });
    expect(pages.at(-1)).toMatchObject({ kind: "custom-key", secretLength: 3, cursor: 2 });
    expect(JSON.stringify(pages)).not.toContain("abd");
  });

  test("edits provider secrets at a private cursor without exposing them", async () => {
    const pages: LoginPage[] = [];
    let submitted = "";
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
      () => ({ setModel: async () => {} }) as any,
      (page) => pages.push(page),
      () => {},
      () => {},
    );
    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    await settle();

    for (const character of "acd") controller.handleKey({ name: character, sequence: character });
    controller.handleKey({ name: "home" });
    controller.handleKey({ name: "right" });
    expect(controller.pasteText("b")).toBe(true);
    controller.handleKey({ name: "delete" });
    expect(pages.at(-1)).toMatchObject({ kind: "prompt", secretLength: 3, cursor: 2 });
    expect(JSON.stringify(pages)).not.toContain("abd");

    controller.handleKey({ name: "end" });
    controller.handleKey({ name: "enter" });
    await settle();
    await settle();
    expect(submitted).toBe("abd");
    expect(JSON.stringify(pages)).not.toContain("abd");
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

  test("ignores provider events that arrive after the login is cancelled", async () => {
    const pages: LoginPage[] = [];
    const launched: string[] = [];
    let notify: ((event: any) => void) | undefined;
    let prompt: ((prompt: any) => Promise<string>) | undefined;
    const runtime = {
      getProviders: () => [{ id: "oauth", name: "OAuth", auth: { oauth: {
        name: "Account", login() {}, refresh() {}, toAuth() {},
      } } }],
      // A device flow only emits device_code after a network round trip, so
      // Escape lands while the provider is still awaiting it.
      login: async (_id: string, _type: string, interaction: any) => {
        notify = interaction.notify;
        prompt = interaction.prompt;
        await new Promise((_resolve, reject) => interaction.signal.addEventListener("abort", () => {
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
    expect(pages.at(-1)?.kind).toBe("working");

    controller.handleKey({ name: "escape" });
    await settle();
    expect(pages.at(-1)?.kind).toBe("providers");
    const settledPages = pages.length;

    notify!({ type: "device_code", userCode: "ABCD", verificationUri: "https://device.test" });
    await expect(prompt!({ type: "secret", message: "Enter API key" }))
      .rejects.toThrow("Login cancelled");
    await settle();

    expect(launched).toEqual([]);
    expect(pages).toHaveLength(settledPages);
    expect(pages.at(-1)?.kind).toBe("providers");
  });

  test("scrubs the custom API key when the popup closes", () => {
    const pages: LoginPage[] = [];
    let closed = false;
    const runtime = { getProviders: () => [] } as any;
    const controller = new LoginController(
      runtime,
      () => ({}) as any,
      (page) => pages.push(page),
      () => {},
      () => { closed = true; },
    );
    controller.open();
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    controller.pasteText("https://local.example.test/v1");
    controller.handleKey({ name: "enter" });
    controller.pasteText("secret-custom-key");
    expect(pages.at(-1)).toMatchObject({ kind: "custom-key", secretLength: 17 });

    const internals = controller as unknown as { customKey: string; customKeyCursor: number };
    expect(internals.customKey).toBe("secret-custom-key");
    controller.close();
    expect(closed).toBe(true);
    expect(internals.customKey).toBe("");
    expect(internals.customKeyCursor).toBe(0);
  });

  test("does not persist a custom provider after the setup is cancelled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-login-test-"));
    temporaryDirectories.push(directory);
    const controllerModule = new URL("./login-controller.ts", import.meta.url).href;
    const script = [
      `import { existsSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { LoginController } from ${JSON.stringify(controllerModule)};`,
      `let controller;`,
      // The endpoint answers, and Escape lands while discovery is still
      // unwinding — after the models are in hand, before the persist step.
      `globalThis.fetch = async () => ({`,
      `  ok: true,`,
      `  async json() {`,
      `    controller.handleKey({ name: "escape" });`,
      `    return { data: [{ id: "local-model" }] };`,
      `  },`,
      `});`,
      `const runtime = {`,
      `  getProviders: () => [],`,
      `  refresh: async () => ({}),`,
      `  login: async () => {},`,
      `  getProvider: () => undefined,`,
      `  getAvailableSnapshot: () => [],`,
      `};`,
      `const pages = [];`,
      `controller = new LoginController(runtime, () => ({}), (page) => pages.push(page), () => {}, () => {});`,
      `controller.open();`,
      `controller.handleKey({ name: "down" });`,
      `controller.handleKey({ name: "enter" });`,
      `controller.pasteText("https://local.example.test/v1");`,
      `controller.handleKey({ name: "enter" });`,
      `controller.handleKey({ name: "enter" });`,
      `await Bun.sleep(50);`,
      `console.log(JSON.stringify({`,
      `  models: existsSync(join(process.env.PUM_DIR, "models.json")),`,
      `  page: pages.at(-1).kind,`,
      `}));`,
      `process.exit(0);`,
    ].join("\n");

    const processResult = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PUM_DIR: directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ models: false, page: "providers" });
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
