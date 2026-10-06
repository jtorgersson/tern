// OpenAI-compatible backend (OpenAI, Ollama, LM Studio, OpenRouter, Groq, vLLM, …) via the official `openai` SDK.
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import * as z from "zod";
import type { AiProvider } from "../types";
import type {
  AgentDriver,
  Backend,
  StructuredRequest,
  TextRequest,
  ToolCall,
  ToolResult,
  TurnRequest,
  TurnResult,
} from "./backend";
import { AiError } from "./errors";

export class OpenAIBackend implements Backend {
  private client: OpenAI;

  constructor(
    public provider: AiProvider,
    public model: string,
    apiKey: string | null,
    fetchImpl: typeof fetch,
  ) {
    this.client = new OpenAI({
      apiKey: apiKey || "not-needed",
      baseURL: provider.baseUrl || undefined,
      fetch: fetchImpl,
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
    });
  }

  async *streamText(req: TextRequest): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      },
      { signal: req.signal },
    );
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta?.content;
      if (d) yield d;
    }
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const schema = z.toJSONSchema(req.schema as z.ZodType, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      {
        role: "user",
        content: `${req.user}\n\nRespond with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`,
      },
    ];
    const formats = [
      { type: "json_schema" as const, json_schema: { name: req.name, schema, strict: false } },
      { type: "json_object" as const },
      undefined,
    ];
    let lastErr: unknown;
    for (const response_format of formats) {
      try {
        const res = await this.client.chat.completions.create(
          { model: this.model, messages, ...(response_format ? { response_format } : {}) },
          { signal: req.signal },
        );
        const text = res.choices[0]?.message?.content ?? "";
        const parsed = req.schema.safeParse(extractJson(text));
        if (parsed.success) return parsed.data;
        lastErr = new AiError("The model returned JSON that didn't match the expected shape.");
      } catch (err) {
        // Servers that don't support a response_format return 400; try the next, weaker option.
        if (err instanceof OpenAI.BadRequestError || err instanceof AiError || err instanceof SyntaxError) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new AiError("Structured output failed.");
  }

  agent(): AgentDriver {
    return new OpenAIDriver(this.client, this.model);
  }
}

/** Pull the first JSON object out of free text (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiError("The model did not return JSON.");
  return JSON.parse(body.slice(start, end + 1));
}

class OpenAIDriver implements AgentDriver {
  private messages: ChatCompletionMessageParam[] = [];

  constructor(private client: OpenAI, private model: string) {}

  pushUser(context: string, text: string): void {
    this.messages.push({ role: "user", content: context ? `${context}\n\n${text}` : text });
  }

  pushToolResults(results: ToolResult[]): void {
    for (const r of results)
      this.messages.push({
        role: "tool",
        tool_call_id: r.id,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      });
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const tools: ChatCompletionTool[] = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.jsonSchema },
    }));
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        messages: [{ role: "system", content: req.system }, ...this.messages],
        tools,
      },
      { signal: req.signal },
    );

    let text = "";
    let finish: string | null = null;
    let sawThinking = false;
    const acc = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string };
      if (!sawThinking && (delta.reasoning || delta.reasoning_content)) {
        sawThinking = true;
        req.onThinking();
      }
      if (delta.content) {
        text += delta.content;
        req.onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const raw = [...acc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
    const calls: ToolCall[] = raw.map((c) => ({ id: c.id, name: c.name, input: safeParse(c.args) }));

    if (finish === "content_filter") return { stop: "refusal", calls: [], text };
    if (finish === "length" && calls.length) return { stop: "max_tokens", calls: [], text };

    this.messages.push({
      role: "assistant",
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: raw.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.args || "{}" },
            })),
          }
        : {}),
    });
    if (calls.length) return { stop: "tool_use", calls, text };
    return { stop: finish === "length" ? "max_tokens" : finish === "stop" ? "end" : "other", calls: [], text };
  }
}

function safeParse(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}
