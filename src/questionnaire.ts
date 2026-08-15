import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const QUESTIONNAIRE_TOOL_NAME = "questionnaire";

export type QuestionnaireOption = {
  value: string;
  label: string;
  description?: string;
};

export type QuestionnaireQuestion = {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionnaireOption[];
};

export type QuestionnaireAnswer = {
  questionId: string;
  value: string;
  label: string;
  custom: boolean;
};

export type QuestionnaireResult = {
  cancelled: boolean;
  answers: QuestionnaireAnswer[];
};

export type QuestionnaireRequester = {
  id: string;
  name: string;
};

export type QuestionnaireRequest = {
  id: string;
  requester: QuestionnaireRequester;
  questions: QuestionnaireQuestion[];
  page: number;
  optionIndices: number[];
  answers: Map<string, QuestionnaireAnswer>;
  customInput: boolean;
};

type PendingRequest = QuestionnaireRequest & {
  resolve: (result: QuestionnaireResult) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

const OptionSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 2_000, description: "Value returned for this option" }),
  label: Type.String({ minLength: 1, maxLength: 2_000, description: "Option text shown to the user" }),
  description: Type.Optional(Type.String({ maxLength: 4_000, description: "Optional supporting text" })),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200, description: "Unique question identifier" }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Short question label" })),
  prompt: Type.String({ minLength: 1, maxLength: 8_000, description: "Question shown to the user" }),
  options: Type.Array(OptionSchema, {
    minItems: 1,
    maxItems: 30,
    description: "Selectable answers. The user can also enter a custom answer.",
  }),
}, { additionalProperties: false });

const QuestionnaireSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 20,
    description: "Questions to ask in one questionnaire",
  }),
}, { additionalProperties: false });

function resultText(result: QuestionnaireResult): string {
  return JSON.stringify(result);
}

export function questionnaireDetail(result: unknown): string | undefined {
  const details = (result as any)?.details as QuestionnaireResult | undefined;
  if (!details || !Array.isArray(details.answers)) return undefined;
  if (details.cancelled) return "cancelled";
  const count = details.answers.length;
  return `${count} answer${count === 1 ? "" : "s"}`;
}

export class QuestionnaireManager {
  private currentRequest?: PendingRequest;
  private readonly queue: PendingRequest[] = [];
  private readonly listeners = new Set<() => void>();
  private uiCount = 0;
  private nextId = 1;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.uiCount += 1;
    listener();
    return () => {
      this.listeners.delete(listener);
      this.uiCount = Math.max(0, this.uiCount - 1);
    };
  }

  current(): QuestionnaireRequest | undefined {
    return this.currentRequest;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private showNext(): void {
    if (this.currentRequest || this.queue.length === 0) return;
    this.currentRequest = this.queue.shift();
    this.emit();
  }

  private finish(request: PendingRequest, result: QuestionnaireResult): void {
    if (request.abortListener) request.signal?.removeEventListener("abort", request.abortListener);
    if (this.currentRequest === request) this.currentRequest = undefined;
    else {
      const index = this.queue.indexOf(request);
      if (index >= 0) this.queue.splice(index, 1);
    }
    request.resolve(result);
    this.emit();
    this.showNext();
  }

  async request(
    requester: QuestionnaireRequester,
    questions: QuestionnaireQuestion[],
    signal?: AbortSignal,
  ): Promise<QuestionnaireResult> {
    if (this.uiCount === 0) throw new Error("The PUM questionnaire UI is unavailable");
    const ids = new Set<string>();
    for (const question of questions) {
      if (ids.has(question.id)) throw new Error(`Duplicate questionnaire question id: ${question.id}`);
      ids.add(question.id);
    }

    return new Promise<QuestionnaireResult>((resolve) => {
      const request: PendingRequest = {
        id: `questionnaire-${this.nextId++}`,
        requester,
        questions,
        page: 0,
        optionIndices: questions.map(() => 0),
        answers: new Map(),
        customInput: false,
        resolve,
        signal,
      };
      request.abortListener = () => this.finish(request, { cancelled: true, answers: [] });
      if (signal?.aborted) {
        resolve({ cancelled: true, answers: [] });
        return;
      }
      signal?.addEventListener("abort", request.abortListener, { once: true });
      this.queue.push(request);
      this.showNext();
    });
  }

  movePage(step: -1 | 1): void {
    const request = this.currentRequest;
    if (!request || request.customInput) return;
    const total = request.questions.length + 1;
    request.page = (request.page + step + total) % total;
    this.emit();
  }

  moveOption(step: -1 | 1): void {
    const request = this.currentRequest;
    if (!request || request.customInput || request.page >= request.questions.length) return;
    const count = request.questions[request.page]!.options.length + 1;
    const current = request.optionIndices[request.page] ?? 0;
    request.optionIndices[request.page] = (current + step + count) % count;
    this.emit();
  }

  select(): "custom" | "selected" | "submitted" | "blocked" {
    const request = this.currentRequest;
    if (!request || request.customInput) return "blocked";
    if (request.page === request.questions.length) {
      if (request.answers.size !== request.questions.length) return "blocked";
      this.finish(request, { cancelled: false, answers: this.orderedAnswers(request) });
      return "submitted";
    }

    const question = request.questions[request.page]!;
    const index = request.optionIndices[request.page] ?? 0;
    if (index === question.options.length) {
      request.customInput = true;
      this.emit();
      return "custom";
    }
    const option = question.options[index]!;
    request.answers.set(question.id, {
      questionId: question.id,
      value: option.value,
      label: option.label,
      custom: false,
    });
    this.advance(request);
    return "selected";
  }

  submitCustom(value: string): boolean {
    const request = this.currentRequest;
    if (!request?.customInput || request.page >= request.questions.length) return false;
    const answer = value.trim();
    if (!answer) return false;
    const question = request.questions[request.page]!;
    request.answers.set(question.id, {
      questionId: question.id,
      value: answer,
      label: answer,
      custom: true,
    });
    request.customInput = false;
    this.advance(request);
    return true;
  }

  cancelCustom(): void {
    const request = this.currentRequest;
    if (!request?.customInput) return;
    request.customInput = false;
    this.emit();
  }

  cancel(): void {
    const request = this.currentRequest;
    if (request) this.finish(request, { cancelled: true, answers: [] });
  }

  /** Answers or cancels the shown questionnaire from a controller instead of the popup. */
  completeCurrent(requestId: string, result: QuestionnaireResult): boolean {
    const request = this.currentRequest;
    // The shown request can be replaced between the controller reading it and
    // answering it — cancelled, aborted, or advanced by the queue — so a result
    // meant for request A must never resolve request B.
    if (!request || request.id !== requestId) return false;
    const answers = this.validatedAnswers(request, result);
    if (!answers) return false;
    // The caller supplies the whole set; partial popup selections are dropped.
    this.finish(request, { cancelled: result.cancelled, answers });
    return true;
  }

  /** Cancels every request, shown or queued, that belongs to one requester. */
  cancelRequester(requesterId: string): void {
    // Snapshot first: finishing the head promotes the next request, and the
    // promoted one still has to be checked.
    for (const request of [this.currentRequest, ...this.queue]) {
      if (request?.requester.id === requesterId) this.finish(request, { cancelled: true, answers: [] });
    }
  }

  // Controller answers get no more trust than tool input: they must cover every
  // question exactly once, and anything not marked custom must be an option the
  // request actually offered.
  private validatedAnswers(
    request: PendingRequest,
    result: QuestionnaireResult,
  ): QuestionnaireAnswer[] | undefined {
    if (!result || typeof result.cancelled !== "boolean" || !Array.isArray(result.answers)) return undefined;
    // A cancellation answers nothing, so it has nothing to check against the questions.
    if (result.cancelled) return result.answers.length === 0 ? [] : undefined;
    if (result.answers.length !== request.questions.length) return undefined;

    const questions = new Map(request.questions.map((question) => [question.id, question]));
    const answers = new Map<string, QuestionnaireAnswer>();
    for (const answer of result.answers) {
      const question = questions.get(answer?.questionId as string);
      if (!question || answers.has(question.id)) return undefined;
      if (typeof answer.value !== "string" || typeof answer.label !== "string") return undefined;
      if (typeof answer.custom !== "boolean") return undefined;
      if (answer.custom) {
        if (!answer.value.trim() || !answer.label.trim()) return undefined;
      } else if (!question.options.some((option) => option.value === answer.value && option.label === answer.label)) {
        return undefined;
      }
      answers.set(question.id, {
        questionId: question.id,
        value: answer.value,
        label: answer.label,
        custom: answer.custom,
      });
    }
    return request.questions.flatMap((question) => {
      const answer = answers.get(question.id);
      return answer ? [answer] : [];
    });
  }

  private advance(request: PendingRequest): void {
    request.page = request.page < request.questions.length - 1
      ? request.page + 1
      : request.questions.length;
    this.emit();
  }

  private orderedAnswers(request: PendingRequest): QuestionnaireAnswer[] {
    return request.questions.flatMap((question) => {
      const answer = request.answers.get(question.id);
      return answer ? [answer] : [];
    });
  }

  registerTool(pi: ExtensionAPI, requester: QuestionnaireRequester): void {
    pi.registerTool({
      name: QUESTIONNAIRE_TOOL_NAME,
      label: "Questionnaire",
      description: "Ask the user one or more multiple-choice questions. Each question also accepts a custom answer.",
      promptSnippet: "Ask the user structured questions with selectable options or custom answers",
      promptGuidelines: [
        "Use questionnaire when user choices or missing requirements block safe progress.",
        "Provide concise questionnaire options that are distinct and actionable.",
      ],
      parameters: QuestionnaireSchema,
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        const result = await this.request(requester, params.questions, signal);
        return {
          content: [{ type: "text" as const, text: resultText(result) }],
          details: result,
        };
      },
    });
  }

  extension(requester: QuestionnaireRequester): InlineExtension {
    return {
      name: `pum-questionnaire-${requester.id}`,
      factory: (pi) => this.registerTool(pi, requester),
    };
  }
}
