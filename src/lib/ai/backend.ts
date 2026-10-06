// Provider-neutral interfaces implemented by anthropic.ts and openai.ts.
import type * as z from "zod";
import type { AiProvider } from "../types";

export type Effort = "low" | "medium" | "high";

export interface TextRequest {
  system: string;
  user: string;
  effort: Effort;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface StructuredRequest<T> extends TextRequest {
  schema: z.ZodType<T>;
  /** Short identifier for the schema (used by OpenAI json_schema). */
  name: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) for the input. */
  jsonSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed input; `undefined` when the model's JSON could not be parsed. */
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export type TurnStop = "end" | "tool_use" | "refusal" | "max_tokens" | "other";

export interface TurnResult {
  stop: TurnStop;
  calls: ToolCall[];
  text: string;
}

export interface TurnRequest {
  system: string;
  tools: ToolSpec[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  onThinking: () => void;
}

/** Holds one conversation's provider-native history. Append-only. */
export interface AgentDriver {
  pushUser(context: string, text: string): void;
  /** Runs one model turn. Appends the assistant message to history only if its tool calls will be run or it ended normally. */
  turn(req: TurnRequest): Promise<TurnResult>;
  /** Must be called with a result for every call of the last `tool_use` turn, in one batch. */
  pushToolResults(results: ToolResult[]): void;
}

export interface Backend {
  provider: AiProvider;
  model: string;
  streamText(req: TextRequest): AsyncGenerator<string>;
  structured<T>(req: StructuredRequest<T>): Promise<T>;
  agent(): AgentDriver;
}
