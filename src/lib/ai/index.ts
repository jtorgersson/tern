// Public surface of the AI layer. See ARCHITECTURE.md.
import type { AiProvider } from "../types";
import { AiError, friendlyError } from "./errors";
import { makeBackend } from "./providers";
import { DEFAULT_ANTHROPIC_MODEL } from "./config";

export { configureAi, hasAi, DEFAULT_ANTHROPIC_MODEL } from "./config";
export { AgentSession, type AgentEvent, type AgentContext } from "./agent";
export { triage, triageInbox } from "./triage";
export { summarizeThread, draftReply, rewrite, briefing, predraftReply, prepMeeting, PREDRAFT_INSTRUCTION, type BriefingInput } from "./writing";
export { AiError, friendlyError, isAbort } from "./errors";
export { resetBackends } from "./providers";
export { textToHtml } from "./tools";

/** Sends a tiny request to check the provider works. Resolves "ok" or throws an AiError with a friendly message. */
export async function testProvider(p: AiProvider): Promise<string> {
  const model = p.model || (p.kind === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "");
  if (!model) throw new AiError("Set a model name first.");
  try {
    const b = await makeBackend(p, model);
    let text = "";
    for await (const d of b.streamText({
      system: "You are a connectivity check.",
      user: "Reply with just: ok",
      effort: "low",
      maxTokens: 2048,
    }))
      text += d;
    if (!text.trim()) throw new AiError(`${p.name} returned an empty response.`);
    return "ok";
  } catch (err) {
    throw err instanceof AiError ? err : new AiError(friendlyError(err, p));
  }
}

/** Suggested presets for the settings UI. */
export const PROVIDER_PRESETS: Array<Pick<AiProvider, "kind" | "name" | "baseUrl" | "model" | "fastModel">> = [
  { kind: "anthropic", name: "Anthropic", baseUrl: null, model: DEFAULT_ANTHROPIC_MODEL, fastModel: null },
  { kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5", fastModel: null },
  { kind: "openai", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1", fastModel: null },
  { kind: "openai", name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "", fastModel: null },
  { kind: "openai", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "", fastModel: null },
];
