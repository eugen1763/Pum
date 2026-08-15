import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { credentialFreeHttpUrl, launchBrowserUrl } from "./browser-launch";
import type { LoginPage } from "./login-popup";
import {
  customProviderId,
  discoverOpenAIModels,
  persistCustomProvider,
  providerLoginMethods,
  refreshAndSelectModel,
  safeError,
  type LoginMethod,
} from "./login-flow";

export type LoginKey = {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
};

function pastedSingleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function filterLoginMethods(methods: readonly LoginMethod[], query: string): LoginMethod[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...methods];
  return methods.filter((method) => {
    const metadata = method.canLogin ? "login available" : "external setup credentials";
    const haystack = `${method.providerName} ${method.providerId} ${method.authType} ${method.methodName} ${method.loginLabel ?? ""} ${metadata}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function customProviderVisible(query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = "custom openai compatible provider endpoint api key local server models";
  return terms.every((term) => haystack.includes(term));
}

type PromptWaiter = {
  prompt: AuthPrompt;
  resolve(value: string): void;
  reject(error: Error): void;
};

export class LoginController {
  private page: LoginPage;
  private controller?: AbortController;
  private promptWaiter?: PromptWaiter;
  private secret = "";
  private secretCursor = 0;
  private endpoint = "";
  private endpointCursor = 0;
  private customKey = "";
  private customKeyCursor = 0;
  private providerCursor = 0;
  private providerQuery = "";
  private providerSearchFocused = true;
  private retry?: () => void;
  private latestBrowserAuthEvent?: Extract<AuthEvent, { type: "auth_url" | "device_code" }>;
  private launchedAuthUrls = new Set<string>();

  constructor(
    private runtime: ModelRuntime,
    private getSession: () => AgentSession,
    private show: (page: LoginPage) => void,
    private complete: (modelId?: string) => void,
    private closePopup: () => void,
    private launchUrl: (url: string) => Promise<boolean> = launchBrowserUrl,
  ) {
    this.page = this.providerPage();
  }

  private setPage(page: LoginPage) {
    this.page = page;
    this.show(page);
  }

  private providerPage(): Extract<LoginPage, { kind: "providers" }> {
    const providers = (this.runtime as any).getProviders?.() ?? [];
    const methods = filterLoginMethods(providerLoginMethods(providers), this.providerQuery);
    const customVisible = customProviderVisible(this.providerQuery);
    const count = methods.length + (customVisible ? 1 : 0);
    this.providerCursor = count > 0 ? Math.min(this.providerCursor, count - 1) : 0;
    return {
      kind: "providers",
      methods,
      cursor: this.providerCursor,
      query: this.providerQuery,
      searchFocused: this.providerSearchFocused,
      customVisible,
    };
  }

  open() {
    this.cancelOperation();
    this.latestBrowserAuthEvent = undefined;
    this.launchedAuthUrls.clear();
    this.retry = undefined;
    this.providerCursor = 0;
    this.providerQuery = "";
    this.providerSearchFocused = true;
    this.setPage(this.providerPage());
  }

  setProviderQuery(query: string) {
    const current = this.page;
    if (current.kind !== "providers") return;
    const selected = current.methods[current.cursor];
    const selectedKey = selected
      ? `${selected.providerId}:${selected.authType}`
      : current.customVisible && current.cursor === current.methods.length ? "custom" : undefined;
    this.providerQuery = query;
    const next = this.providerPage();
    if (selectedKey === "custom" && next.customVisible) this.providerCursor = next.methods.length;
    else if (selectedKey) {
      const index = next.methods.findIndex((method) => `${method.providerId}:${method.authType}` === selectedKey);
      if (index >= 0) this.providerCursor = index;
    }
    this.setPage({ ...next, cursor: this.providerCursor });
  }

  cancelOperation() {
    this.controller?.abort();
    this.controller = undefined;
    this.promptWaiter?.reject(new Error("Login cancelled"));
    this.promptWaiter = undefined;
    this.secret = "";
    this.secretCursor = 0;
  }

  close() {
    this.cancelOperation();
    this.closePopup();
  }

  private async finish(providerId: string, providerName: string) {
    const session = this.getSession();
    const selected = await refreshAndSelectModel(
      this.runtime,
      providerId,
      (model) => session.setModel(model),
      AbortSignal.timeout(15_000),
      session.model,
    );
    this.complete(selected?.id);
    this.setPage({
      kind: "success",
      message: selected
        ? `${providerName} is ready. Selected ${selected.id}.`
        : `${providerName} is configured. Open Settings to select an available model.`,
    });
  }

  private startProvider(method: LoginMethod) {
    this.retry = () => this.startProvider(method);
    if (!method.canLogin) {
      this.setPage({
        kind: "error",
        title: `${method.providerName} uses external credentials`,
        message: "Configure the provider environment or credential files, then retry.",
      });
      return;
    }
    const controller = new AbortController();
    this.cancelOperation();
    this.latestBrowserAuthEvent = undefined;
    this.launchedAuthUrls.clear();
    this.controller = controller;
    this.setPage({ kind: "working", providerName: method.providerName });
    void this.runtime.login(method.providerId, method.authType, {
      signal: controller.signal,
      notify: (event: AuthEvent) => {
        if (event.type === "auth_url" || event.type === "device_code") {
          this.latestBrowserAuthEvent = event;
        }
        const eventUrl = event.type === "auth_url"
          ? event.url
          : event.type === "device_code"
            ? event.verificationUri
            : undefined;
        const safeUrl = eventUrl ? credentialFreeHttpUrl(eventUrl) : null;
        if (safeUrl && !this.launchedAuthUrls.has(safeUrl)) {
          this.launchedAuthUrls.add(safeUrl);
          void this.launchUrl(safeUrl).catch(() => {});
        }
        if (!this.promptWaiter) this.setPage({ kind: "working", providerName: method.providerName, event });
      },
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        this.secret = "";
        this.secretCursor = 0;
        const rejectPrompt = (error: Error) => {
          prompt.signal?.removeEventListener("abort", onAbort);
          reject(error);
        };
        const resolvePrompt = (value: string) => {
          prompt.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = () => rejectPrompt(new Error("Login cancelled"));
        prompt.signal?.addEventListener("abort", onAbort, { once: true });
        this.promptWaiter = { prompt, resolve: resolvePrompt, reject: rejectPrompt };
        this.setPage({
          kind: "prompt",
          providerName: method.providerName,
          prompt,
          event: this.latestBrowserAuthEvent,
          cursor: 0,
          value: "",
          secretLength: 0,
        });
      }),
    }).then(() => {
      this.promptWaiter = undefined;
      this.secret = "";
      return this.finish(method.providerId, method.providerName);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      this.setPage({ kind: "error", title: `${method.providerName} login failed`, message: safeError(error, [this.secret]) });
      this.secret = "";
    });
  }

  private startCustom() {
    const endpoint = this.endpoint;
    const key = this.customKey;
    this.retry = () => this.startCustom();
    const controller = new AbortController();
    this.cancelOperation();
    this.controller = controller;
    this.setPage({ kind: "custom-working", endpoint, message: "Discovering OpenAI-compatible models…" });
    void discoverOpenAIModels(endpoint, key, { signal: controller.signal }).then(async ({ baseUrl, models }) => {
      const providerId = customProviderId(baseUrl);
      this.setPage({ kind: "custom-working", endpoint, message: `Saving ${models.length} discovered models…` });
      await persistCustomProvider(providerId, baseUrl, models);
      await this.runtime.refresh({ providers: [providerId], signal: controller.signal });
      await this.runtime.login(providerId, "api_key", {
        signal: controller.signal,
        notify: () => {},
        prompt: async () => key || "local",
      });
      this.customKey = "";
      await this.finish(providerId, this.runtime.getProvider(providerId)?.name ?? providerId);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      this.setPage({ kind: "error", title: "Custom provider setup failed", message: safeError(error, [key]) });
    });
  }

  private updateText(
    key: LoginKey,
    value: string,
    cursor: number,
    setValue: (next: string, nextCursor: number) => void,
  ): boolean {
    const safeCursor = Math.max(0, Math.min(cursor, value.length));
    if (key.name === "left") {
      setValue(value, Math.max(0, safeCursor - 1));
      return true;
    }
    if (key.name === "right") {
      setValue(value, Math.min(value.length, safeCursor + 1));
      return true;
    }
    if (key.name === "home") {
      setValue(value, 0);
      return true;
    }
    if (key.name === "end") {
      setValue(value, value.length);
      return true;
    }
    if (key.name === "backspace") {
      if (safeCursor > 0) {
        setValue(
          value.slice(0, safeCursor - 1) + value.slice(safeCursor),
          safeCursor - 1,
        );
      }
      return true;
    }
    if (key.name === "delete") {
      if (safeCursor < value.length) {
        setValue(
          value.slice(0, safeCursor) + value.slice(safeCursor + 1),
          safeCursor,
        );
      }
      return true;
    }
    const text = key.sequence ?? "";
    if (!key.ctrl && !key.meta && !key.option && text.length > 0 && !/[\u0000-\u001f\u007f]/.test(text)) {
      setValue(
        value.slice(0, safeCursor) + text + value.slice(safeCursor),
        safeCursor + text.length,
      );
      return true;
    }
    return false;
  }

  acceptsTextPaste(): boolean {
    return this.page.kind === "custom-endpoint" ||
      this.page.kind === "custom-key" ||
      (this.page.kind === "prompt" && this.page.prompt.type !== "select");
  }

  pasteText(text: string): boolean {
    if (!this.acceptsTextPaste()) return false;
    const pasted = pastedSingleLine(text);
    if (!pasted) return true;

    if (this.page.kind === "prompt") {
      const current = this.page;
      if (current.prompt.type === "secret") {
        const cursor = Math.max(0, Math.min(this.secretCursor, this.secret.length));
        this.secret = this.secret.slice(0, cursor) + pasted + this.secret.slice(cursor);
        this.secretCursor = cursor + pasted.length;
        this.setPage({ ...current, cursor: this.secretCursor, secretLength: this.secret.length });
      } else {
        const cursor = Math.max(0, Math.min(current.cursor, current.value.length));
        this.setPage({
          ...current,
          value: current.value.slice(0, cursor) + pasted + current.value.slice(cursor),
          cursor: cursor + pasted.length,
        });
      }
      return true;
    }
    if (this.page.kind === "custom-endpoint") {
      const cursor = Math.max(0, Math.min(this.page.cursor, this.page.endpoint.length));
      this.endpoint = this.page.endpoint.slice(0, cursor) + pasted + this.page.endpoint.slice(cursor);
      this.endpointCursor = cursor + pasted.length;
      this.setPage({ kind: "custom-endpoint", endpoint: this.endpoint, cursor: this.endpointCursor });
      return true;
    }
    if (this.page.kind === "custom-key") {
      const current = this.page;
      const cursor = Math.max(0, Math.min(this.customKeyCursor, this.customKey.length));
      this.customKey = this.customKey.slice(0, cursor) + pasted + this.customKey.slice(cursor);
      this.customKeyCursor = cursor + pasted.length;
      this.setPage({ ...current, cursor: this.customKeyCursor, secretLength: this.customKey.length });
      return true;
    }
    return false;
  }

  handleKey(key: LoginKey): boolean {
    const enter = key.name === "return" || key.name === "enter" || key.name === "kpenter" || key.name === "linefeed";
    if (key.name === "escape") {
      if (this.page.kind === "providers" || this.page.kind === "success" || this.page.kind === "error") this.close();
      else if (this.page.kind === "custom-key") this.setPage({ kind: "custom-endpoint", endpoint: this.endpoint, cursor: this.endpointCursor });
      else {
        this.cancelOperation();
        this.setPage(this.providerPage());
      }
      return true;
    }
    if (this.page.kind === "providers") {
      const count = this.page.methods.length + (this.page.customVisible ? 1 : 0);
      const slash = !key.ctrl && !key.meta && !key.option && (key.name === "/" || key.sequence === "/");
      if (this.page.searchFocused) {
        if ((key.name === "up" || key.name === "down" || enter) && count > 0) {
          this.providerSearchFocused = false;
          this.setPage({ ...this.page, searchFocused: false });
          return true;
        }
        return false;
      }
      if (slash) {
        this.providerSearchFocused = true;
        this.setPage({ ...this.page, searchFocused: true });
        return true;
      }
      if (key.name === "up" || key.name === "down") {
        if (count === 0) return true;
        const step = key.name === "up" ? -1 : 1;
        this.providerCursor = (this.page.cursor + step + count) % count;
        this.setPage({ ...this.page, cursor: this.providerCursor });
      } else if (enter) {
        const method = this.page.methods[this.page.cursor];
        if (method) this.startProvider(method);
        else if (this.page.customVisible) {
          this.endpointCursor = this.endpoint.length;
          this.setPage({ kind: "custom-endpoint", endpoint: this.endpoint, cursor: this.endpointCursor });
        }
      }
      return true;
    }
    if (this.page.kind === "prompt") {
      if (this.page.prompt.type === "select") {
        if (key.name === "up" || key.name === "down") {
          const count = this.page.prompt.options.length;
          if (count) this.setPage({ ...this.page, cursor: (this.page.cursor + (key.name === "up" ? -1 : 1) + count) % count });
        } else if (enter) {
          const option = this.page.prompt.options[this.page.cursor];
          if (option) {
            this.promptWaiter?.resolve(option.id);
            this.promptWaiter = undefined;
            this.setPage({ kind: "working", providerName: this.page.providerName });
          }
        }
      } else if (enter) {
        const value = this.page.prompt.type === "secret" ? this.secret : this.page.value;
        this.promptWaiter?.resolve(value);
        this.promptWaiter = undefined;
        this.setPage({ kind: "working", providerName: this.page.providerName });
      } else if (this.page.prompt.type === "secret") {
        const current = this.page;
        this.updateText(key, this.secret, this.secretCursor, (next, nextCursor) => {
          this.secret = next;
          this.secretCursor = nextCursor;
          this.setPage({ ...current, cursor: nextCursor, secretLength: next.length });
        });
      } else {
        const current = this.page;
        this.updateText(key, current.value, current.cursor, (next, nextCursor) => {
          this.setPage({ ...current, value: next, cursor: nextCursor });
        });
      }
      return true;
    }
    if (this.page.kind === "custom-endpoint") {
      if (enter) {
        this.endpoint = this.page.endpoint;
        this.endpointCursor = this.page.cursor;
        this.customKeyCursor = this.customKey.length;
        this.setPage({ kind: "custom-key", endpoint: this.endpoint, secretLength: this.customKey.length, cursor: this.customKeyCursor });
      } else this.updateText(key, this.page.endpoint, this.page.cursor, (next, nextCursor) => {
        this.endpoint = next;
        this.endpointCursor = nextCursor;
        this.setPage({ kind: "custom-endpoint", endpoint: next, cursor: nextCursor });
      });
      return true;
    }
    if (this.page.kind === "custom-key") {
      if (enter) this.startCustom();
      else {
        const current = this.page;
        this.updateText(key, this.customKey, this.customKeyCursor, (next, nextCursor) => {
          this.customKey = next;
          this.customKeyCursor = nextCursor;
          this.setPage({ ...current, cursor: nextCursor, secretLength: next.length });
        });
      }
      return true;
    }
    if (this.page.kind === "error" && enter) {
      this.retry?.();
      return true;
    }
    if (this.page.kind === "success" && enter) {
      this.close();
      return true;
    }
    return true;
  }
}
