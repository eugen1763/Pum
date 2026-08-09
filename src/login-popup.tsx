import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { Theme } from "./theme";
import type { LoginMethod } from "./login-flow";

export type LoginPage =
  | { kind: "providers"; methods: readonly LoginMethod[]; cursor: number }
  | { kind: "prompt"; providerName: string; prompt: AuthPrompt; cursor: number; value: string; secretLength: number }
  | { kind: "working"; providerName: string; event?: AuthEvent }
  | { kind: "custom-endpoint"; endpoint: string }
  | { kind: "custom-key"; endpoint: string; secretLength: number }
  | { kind: "custom-working"; endpoint: string; message: string }
  | { kind: "error"; title: string; message: string }
  | { kind: "success"; message: string };

function popupGeometry(width: number, height: number) {
  const narrow = width < 64;
  const margin = narrow ? 1 : Math.max(2, Math.floor(width * 0.1));
  return {
    left: margin,
    width: Math.max(24, width - margin * 2),
    height: Math.max(10, Math.min(height - 2, 22)),
  };
}

function InputRow({ theme, label, value, secret = false }: { theme: Theme; label: string; value: string; secret?: boolean }) {
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <box style={{ width: 12, flexShrink: 0 }}><text content={label} fg={theme.dim} bg={theme.popupBg} /></box>
      <text content={secret ? "•".repeat(value.length) : value} fg={theme.fg} bg={theme.popupBg} wrapMode="none" />
      <text content="▌" fg={theme.accent} bg={theme.popupBg} />
    </box>
  );
}

function EventDetails({ theme, event }: { theme: Theme; event?: AuthEvent }) {
  if (!event) return <text content="Starting authentication…" fg={theme.dim} bg={theme.popupBg} />;
  if (event.type === "auth_url") {
    return <>
      <text content={event.instructions ?? "Open this URL in a browser:"} fg={theme.fg} bg={theme.popupBg} />
      <text content={event.url} fg={theme.accent} bg={theme.popupBg} selectable wrapMode="word" />
    </>;
  }
  if (event.type === "device_code") {
    return <>
      <text content="Open this URL and enter the code:" fg={theme.fg} bg={theme.popupBg} />
      <text content={event.verificationUri} fg={theme.accent} bg={theme.popupBg} selectable wrapMode="word" />
      <text content={event.userCode} fg={theme.accent} bg={theme.popupBg} selectable />
    </>;
  }
  if (event.type === "info") {
    return <>
      <text content={event.message} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
      {event.links?.map((link) => <text key={link.url} content={`${link.label ? `${link.label}: ` : ""}${link.url}`} fg={theme.accent} bg={theme.popupBg} selectable wrapMode="word" />)}
    </>;
  }
  return <text content={event.message} fg={theme.dim} bg={theme.popupBg} wrapMode="word" />;
}

export function LoginPopup({ theme, page, terminalWidth, terminalHeight }: {
  theme: Theme;
  page: LoginPage;
  terminalWidth: number;
  terminalHeight: number;
}) {
  const geometry = popupGeometry(terminalWidth, terminalHeight);
  const title = page.kind === "providers" ? " Login " : page.kind.startsWith("custom") ? " Custom provider " : " Provider login ";
  return (
    <box
      title={title}
      style={{
        position: "absolute",
        top: Math.max(1, Math.floor((terminalHeight - geometry.height) / 2)),
        left: geometry.left,
        width: geometry.width,
        height: geometry.height,
        zIndex: 120,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: 1,
      }}
    >
      {page.kind === "providers" ? <>
        <text content="Select a provider login method" fg={theme.dim} bg={theme.popupBg} />
        <box style={{ height: 1, flexShrink: 0 }} />
        <scrollbox style={{ flexGrow: 1, minHeight: 1 }} verticalScrollbarOptions={{ visible: true }}>
          <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
            {page.methods.map((method, index) => {
              const selected = page.cursor === index;
              const label = `${method.providerName} — ${method.authType === "oauth" ? method.loginLabel ?? method.methodName : method.methodName}`;
              return <box key={`${method.providerId}:${method.authType}`} style={{ height: 1, flexShrink: 0, backgroundColor: selected ? theme.selectionBg : theme.popupBg }}>
                <text content={`${selected ? "› " : "  "}${label}${method.canLogin ? "" : " (external setup)"}`} fg={selected ? theme.accent : theme.fg} bg={selected ? theme.selectionBg : theme.popupBg} wrapMode="none" />
              </box>;
            })}
            <box style={{ height: 1, flexShrink: 0, backgroundColor: page.cursor === page.methods.length ? theme.selectionBg : theme.popupBg }}>
              <text content={`${page.cursor === page.methods.length ? "› " : "  "}Custom OpenAI-compatible provider`} fg={page.cursor === page.methods.length ? theme.accent : theme.fg} bg={page.cursor === page.methods.length ? theme.selectionBg : theme.popupBg} />
            </box>
          </box>
        </scrollbox>
        <text content="↑↓ move   enter select   esc close" fg={theme.dim} bg={theme.popupBg} />
      </> : page.kind === "prompt" ? <>
        <text content={page.providerName} fg={theme.accent} bg={theme.popupBg} />
        <text content={page.prompt.message} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
        <box style={{ height: 1, flexShrink: 0 }} />
        {page.prompt.type === "select" ? page.prompt.options.map((option, index) => {
          const selected = index === page.cursor;
          return <box key={option.id} style={{ flexDirection: "column", flexShrink: 0, backgroundColor: selected ? theme.selectionBg : theme.popupBg }}>
            <text content={`${selected ? "› " : "  "}${option.label}`} fg={selected ? theme.accent : theme.fg} bg={selected ? theme.selectionBg : theme.popupBg} />
            {option.description ? <text content={`  ${option.description}`} fg={theme.dim} bg={selected ? theme.selectionBg : theme.popupBg} /> : null}
          </box>;
        }) : <InputRow theme={theme} label={page.prompt.type === "secret" ? "API key" : "Value"} value={page.prompt.type === "secret" ? "x".repeat(page.secretLength) : page.value} secret={page.prompt.type === "secret"} />}
        <text content="enter continue   esc cancel" fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </> : page.kind === "working" ? <>
        <text content={page.providerName} fg={theme.accent} bg={theme.popupBg} />
        <box style={{ height: 1, flexShrink: 0 }} />
        <EventDetails theme={theme} event={page.event} />
        <text content="URLs and codes are selectable for copying. Esc cancels." fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </> : page.kind === "custom-endpoint" ? <>
        <text content="Enter the server endpoint. PUM probes /models and configures OpenAI Chat Completions only after that probe succeeds." fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
        <box style={{ height: 1, flexShrink: 0 }} />
        <InputRow theme={theme} label="Endpoint" value={page.endpoint} />
        <text content="Example: http://localhost:11434/v1" fg={theme.dim} bg={theme.popupBg} />
        <text content="enter continue   esc back" fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </> : page.kind === "custom-key" ? <>
        <text content="Enter the API key. Leave the field empty for a keyless local server." fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
        <box style={{ height: 1, flexShrink: 0 }} />
        <InputRow theme={theme} label="API key" value={"x".repeat(page.secretLength)} secret />
        <text content="The key is stored in PUM auth.json. The key is not stored in models.json." fg={theme.dim} bg={theme.popupBg} wrapMode="word" />
        <text content="enter discover   esc back" fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </> : page.kind === "custom-working" ? <>
        <text content={page.message} fg={theme.dim} bg={theme.popupBg} wrapMode="word" />
        <text content="Esc cancels." fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </> : page.kind === "error" ? <>
        <text content={page.title} fg={theme.error} bg={theme.popupBg} />
        <text content={page.message} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
        <text content="enter retry   esc close" fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </> : <>
        <text content="✓ Setup complete" fg={theme.success} bg={theme.popupBg} />
        <text content={page.message} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
        <text content="enter or esc close" fg={theme.dim} bg={theme.popupBg} style={{ marginTop: 1 }} />
      </>}
    </box>
  );
}
