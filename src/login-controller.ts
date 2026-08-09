import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  private endpoint = "";
  private customKey = "";
  private providerCursor = 0;
  private retry?: () => void;

  constructor(
    private runtime: ModelRuntime,
    private getSession: () => AgentSession,
    private show: (page: LoginPage) => void,
    private complete: (modelId?: string) => void,
    private closePopup: () => void,
  ) {
    this.page = this.providerPage();
  }

  private setPage(page: LoginPage) {
    this.page = page;
    this.show(page);
  }

  private providerPage(): LoginPage {
    const providers = (this.runtime as any).getProviders?.() ?? [];
    const methods = providerLoginMethods(providers);
    this.providerCursor = Math.min(this.providerCursor, methods.length);
    return { kind: "providers", methods, cursor: this.providerCursor };
  }

  open() {
    this.cancelOperation();
    this.retry = undefined;
    this.providerCursor = 0;
    this.setPage(this.providerPage());
  }

  cancelOperation() {
    this.controller?.abort();
    this.controller = undefined;
    this.promptWaiter?.reject(new Error("Login cancelled"));
    this.promptWaiter = undefined;
    this.secret = "";
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
    this.controller = controller;
    this.setPage({ kind: "working", providerName: method.providerName });
    void this.runtime.login(method.providerId, method.authType, {
      signal: controller.signal,
      notify: (event: AuthEvent) => {
        if (!this.promptWaiter) this.setPage({ kind: "working", providerName: method.providerName, event });
      },
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        this.secret = "";
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
        this.setPage({ kind: "prompt", providerName: method.providerName, prompt, cursor: 0, value: "", secretLength: 0 });
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

  private updateText(key: LoginKey, value: string, setValue: (next: string) => void): boolean {
    if (key.name === "backspace") {
      setValue(value.slice(0, -1));
      return true;
    }
    const text = key.sequence ?? "";
    if (!key.ctrl && !key.meta && !key.option && text.length > 0 && !/[\u0000-\u001f\u007f]/.test(text)) {
      setValue(value + text);
      return true;
    }
    return false;
  }

  handleKey(key: LoginKey): boolean {
    const enter = key.name === "return" || key.name === "enter" || key.name === "kpenter" || key.name === "linefeed";
    if (key.name === "escape") {
      if (this.page.kind === "providers" || this.page.kind === "success" || this.page.kind === "error") this.close();
      else if (this.page.kind === "custom-key") this.setPage({ kind: "custom-endpoint", endpoint: this.endpoint });
      else {
        this.cancelOperation();
        this.setPage(this.providerPage());
      }
      return true;
    }
    if (this.page.kind === "providers") {
      const count = this.page.methods.length + 1;
      if (key.name === "up" || key.name === "down") {
        const step = key.name === "up" ? -1 : 1;
        this.providerCursor = (this.page.cursor + step + count) % count;
        this.setPage({ ...this.page, cursor: this.providerCursor });
      } else if (enter) {
        const method = this.page.methods[this.page.cursor];
        if (method) this.startProvider(method);
        else this.setPage({ kind: "custom-endpoint", endpoint: this.endpoint });
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
        this.updateText(key, this.secret, (next) => {
          this.secret = next;
          this.setPage({ ...current, secretLength: next.length });
        });
      } else {
        const current = this.page;
        this.updateText(key, current.value, (next) => this.setPage({ ...current, value: next }));
      }
      return true;
    }
    if (this.page.kind === "custom-endpoint") {
      if (enter) {
        this.endpoint = this.page.endpoint;
        this.setPage({ kind: "custom-key", endpoint: this.endpoint, secretLength: this.customKey.length });
      } else this.updateText(key, this.page.endpoint, (next) => {
        this.endpoint = next;
        this.setPage({ kind: "custom-endpoint", endpoint: next });
      });
      return true;
    }
    if (this.page.kind === "custom-key") {
      if (enter) this.startCustom();
      else {
        const current = this.page;
        this.updateText(key, this.customKey, (next) => {
          this.customKey = next;
          this.setPage({ ...current, secretLength: next.length });
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
