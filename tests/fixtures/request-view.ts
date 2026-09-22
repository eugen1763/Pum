import { getCurrentSystemPrompt, getCurrentTools, type Message, type Tool } from "@earendil-works/pi-ai";

export interface RequestView {
  systemPrompt: string;
  tools: Tool[];
  messages: Message[];
}

/**
 * Split a provider request into its effective prompt, tools and conversation.
 * pi sends the prompt and tool declarations as system messages in the transcript.
 */
export function requestView(context: { messages: readonly Message[] }): RequestView {
  const messages = structuredClone([...context.messages]);
  return {
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages),
    messages: messages.filter((message) => message.role !== "system"),
  };
}
