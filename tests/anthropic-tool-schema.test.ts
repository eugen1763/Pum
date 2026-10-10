import { describe, expect, test } from "bun:test";
import { createModels, normalizeContext, validateToolArguments, type Model, type Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_BASH_OUTPUT, withBashOutput, type BashToolLike } from "../src/bash-output";

// Exercise the installed provider's conversion and HTTP dispatch, not a copy of
// its strict-schema helper. No credentials, PUM config or paid requests are used.
function fixture() {
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    requests.push(body);
    if (body.tools?.some((tool: any) => tool.strict === true && tool.input_schema.properties.patterns?.maxItems)) {
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "maxItems is unsupported in strict tools" } }, { status: 400 });
    }
    const events = [
      { type: "message_start", message: { id: "local-message", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  } });
  const provider = anthropicProvider();
  const models = createModels();
  models.setProvider(provider);
  const catalogModel = models.getModel("anthropic", "claude-sonnet-4-6")! as Model<"anthropic-messages">;
  expect(catalogModel).toBeDefined();
  expect(catalogModel.compat?.supportsStrictTools).toBe(true);
  const model = { ...catalogModel, baseUrl: `http://127.0.0.1:${server.port}` };
  const payloads: any[] = [];
  return {
    requests, payloads,
    async run(tools: Tool[]) {
      const stream = await provider.streamSimple(model, normalizeContext({
        systemPrompt: "Local schema regression fixture", tools,
        messages: [{ role: "user", content: "Return an empty response", timestamp: 1 }],
      }), { apiKey: "local-fixture-key", maxRetries: 0, timeoutMs: 2000,
        onPayload(body) { payloads.push(structuredClone(body)); },
      });
      return stream.result();
    },
    dispose() { server.stop(true); },
  };
}

function pumBash(): Tool {
  // PUM's real wrapper preserves the native Bash constrainedSampling preference
  // while replacing parameters with its bounded output schema.
  return withBashOutput(createBashTool(process.cwd()) as unknown as BashToolLike, () => DEFAULT_BASH_OUTPUT) as Tool;
}

const compatibleTool: Tool = {
  name: "compatible", description: "Strict-compatible control",
  parameters: Type.Object({ text: Type.String(), optional: Type.Optional(Type.Boolean()) }),
  constrainedSampling: { type: "json_schema", strict: "prefer" },
};

describe("installed Anthropic provider tool schemas", () => {
  test("PUM Bash falls back without dropping maxItems; compatible tools remain strict", async () => {
    const h = fixture();
    const bash = pumBash();
    const original = structuredClone(bash.parameters);
    expect(bash.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    try {
      expect((await h.run([bash, compatibleTool])).stopReason).toBe("stop");
      expect(h.requests).toHaveLength(1);
      expect(h.payloads).toHaveLength(1);
      expect(h.requests[0].tools).toEqual(h.payloads[0].tools);
      const [sentBash, sentCompatible] = h.requests[0].tools;
      expect(sentBash.name).toBe("bash");
      expect(sentBash.strict).toBeUndefined();
      expect(sentBash.input_schema.properties.patterns.maxItems).toBe(16);
      expect(sentBash.input_schema.required).toEqual(["command"]);
      expect(sentCompatible.strict).toBe(true);
      expect(sentCompatible.input_schema.additionalProperties).toBe(false);
      expect(sentCompatible.input_schema.required).toEqual(["text", "optional"]);
      expect(bash.parameters).toEqual(original);
    } finally { h.dispose(); }
  });

  test("required strict sampling rejects unsupported Bash schema before payload or HTTP dispatch", async () => {
    const h = fixture();
    try {
      const result = await h.run([{ ...pumBash(), constrainedSampling: { type: "json_schema", strict: "require" } }]);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain('Tool "bash" requires JSON-schema constrained sampling');
      expect(result.errorMessage).toContain("maxItems");
      expect(h.payloads).toHaveLength(0);
      expect(h.requests).toHaveLength(0);
    } finally { h.dispose(); }
  });

  test("compatible required-strict tools dispatch in strict mode", async () => {
    const h = fixture();
    try {
      const result = await h.run([{ ...compatibleTool, constrainedSampling: { type: "json_schema", strict: "require" } }]);
      expect(result.stopReason).toBe("stop");
      expect(h.requests[0].tools[0].strict).toBe(true);
    } finally { h.dispose(); }
  });

  test("local SDK validation still accepts 16 patterns and rejects 17 after fallback", async () => {
    const h = fixture();
    const bash = pumBash();
    try {
      expect((await h.run([bash])).stopReason).toBe("stop");
      const call = (count: number) => ({ type: "toolCall" as const, id: "local-call", name: "bash",
        arguments: { command: "printf fixture", patterns: Array.from({ length: count }, () => "error") },
      });
      expect(validateToolArguments(bash, call(16)).patterns).toHaveLength(16);
      expect(() => validateToolArguments(bash, call(17))).toThrow("Validation failed for tool");
      expect((bash.parameters as any).properties.patterns.maxItems).toBe(16);
    } finally { h.dispose(); }
  });
});
