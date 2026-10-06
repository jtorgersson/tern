// Anthropic backend: official SDK, streaming, structured outputs, tool-use loop driver.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type * as z from "zod";
import type { AiProvider } from "../types";
import type {
  AgentDriver,
  Backend,
  Effort,
  StructuredRequest,
  TextRequest,
  ToolResult,
  TurnRequest,
  TurnResult,
} from "./backend";
import { AiError } from "./errors";

/** Models with server-side refusal fallback (`fallbacks: "default"`) on the first-party API. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
/** Older models where `output_config.effort` is rejected. */
const NO_EFFORT = /haiku|claude-3|sonnet-4-5|sonnet-4-0|opus-4-0|opus-4-1|sonnet-4-2/;

const EPHEMERAL = { type: "ephemeral" as const };

export class AnthropicBackend implements Backend {
  private client: Anthropic;

  constructor(
    public provider: AiProvider,
    public model: string,
    apiKey: string | null,
    fetchImpl: typeof fetch,
  ) {
    this.client = new Anthropic({
      apiKey: apiKey ?? "",
      baseURL: provider.baseUrl || undefined,
      fetch: fetchImpl,
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
    });
  }

  /** Params shared by every request: model, effort, refusal fallback. */
  private common(effort: Effort) {
    const p: {
      model: string;
      output_config?: { effort: Effort };
      betas?: string[];
      fallbacks?: "default";
    } = { model: this.model };
    if (!NO_EFFORT.test(this.model)) p.output_config = { effort };
    if (!this.provider.baseUrl && FALLBACK_MODELS.has(this.model)) {
      p.betas = ["server-side-fallback-2026-07-01"];
      p.fallbacks = "default";
    }
    return p;
  }

  async *streamText(req: TextRequest): AsyncGenerator<string> {
    const stream = this.client.beta.messages.stream(
      {
        ...this.common(req.effort),
        max_tokens: req.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
        messages: [{ role: "user", content: req.user }],
      },
      { signal: req.signal },
    );
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal")
      throw new AiError("The model declined this request.");
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const common = this.common(req.effort);
    const res = await this.client.beta.messages.parse(
      {
        ...common,
        max_tokens: req.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
        messages: [{ role: "user", content: req.user }],
        output_config: {
          ...(common.output_config ?? {}),
          format: betaZodOutputFormat(req.schema as z.ZodType<T>),
        },
      },
      { signal: req.signal },
    );
    if (res.stop_reason === "refusal") throw new AiError("The model declined this request.");
    if (res.stop_reason === "max_tokens") throw new AiError("Response was cut off (max tokens).");
    if (res.parsed_output == null) throw new AiError("The model returned unparseable output.");
    return res.parsed_output as T;
  }

  agent(): AgentDriver {
    return new AnthropicDriver(this.client, this.model, () => this.common("medium"));
  }
}

class AnthropicDriver implements AgentDriver {
  private messages: BetaMessageParam[] = [];

  constructor(
    private client: Anthropic,
    private model: string,
    private common: () => ReturnType<AnthropicBackend["common"]>,
  ) {}

  pushUser(context: string, text: string): void {
    const content: BetaTextBlockParam[] = [];
    if (context) content.push({ type: "text", text: context });
    content.push({ type: "text", text });
    this.messages.push({ role: "user", content });
  }

  pushToolResults(results: ToolResult[]): void {
    const content: BetaContentBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    }));
    this.messages.push({ role: "user", content });
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const tools: BetaToolUnion[] = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema as BetaToolUnion extends { input_schema: infer S } ? S : never,
      eager_input_streaming: true,
      ...(i === req.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    })) as BetaToolUnion[];

    // Eager input streaming: an unparseable tool input rejects finalMessage(); re-issue the turn (max 2).
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          ...this.common(),
          max_tokens: 32000,
          cache_control: EPHEMERAL,
          system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
          tools,
          messages: this.messages,
        },
        { signal: req.signal },
      );
      let sawThinking = false;
      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_start" && !sawThinking &&
            (ev.content_block.type === "thinking" || ev.content_block.type === "redacted_thinking")) {
          sawThinking = true;
          req.onThinking();
        }
      });
      stream.on("text", (delta) => req.onText(delta));

      let message;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError || attempt >= 2) throw err;
        if (req.signal.aborted) throw err;
        continue;
      }

      const text = message.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = message.content
        .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      switch (message.stop_reason) {
        case "refusal":
          // Never run tools from a refused turn; don't append it (history stays valid).
          return { stop: "refusal", calls: [], text };
        case "max_tokens":
          if (calls.length) return { stop: "max_tokens", calls: [], text };
          this.messages.push({ role: "assistant", content: message.content });
          return { stop: "max_tokens", calls: [], text };
        default:
          this.messages.push({ role: "assistant", content: message.content });
          if (calls.length) return { stop: "tool_use", calls, text };
          return { stop: message.stop_reason === "end_turn" ? "end" : "other", calls: [], text };
      }
    }
  }
}
