// Builds (and caches) a Backend for the configured provider.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { api } from "../api";
import type { AiProvider } from "../types";
import { AnthropicBackend } from "./anthropic";
import type { Backend } from "./backend";
import { resolve, type Purpose } from "./config";
import { OpenAIBackend } from "./openai";

// Route SDK traffic through Rust (tauri-plugin-http) so local servers / CORS aren't an issue.
const fetchImpl = tauriFetch as unknown as typeof fetch;

const cache = new Map<string, Backend>();

function cacheKey(p: AiProvider, model: string, key: string | null): string {
  return JSON.stringify([p.id, p.kind, p.baseUrl, model, key]);
}

export async function makeBackend(provider: AiProvider, model: string): Promise<Backend> {
  const key = await api.secretGet(`ai:${provider.id}`).catch(() => null);
  const ck = cacheKey(provider, model, key);
  const hit = cache.get(ck);
  if (hit) return hit;
  const b =
    provider.kind === "anthropic"
      ? new AnthropicBackend(provider, model, key, fetchImpl)
      : new OpenAIBackend(provider, model, key, fetchImpl);
  cache.set(ck, b);
  return b;
}

export async function backend(purpose: Purpose = "main"): Promise<Backend> {
  const { provider, model } = resolve(purpose);
  return makeBackend(provider, model);
}

/** Drop cached clients (call after keys/providers change). */
export function resetBackends(): void {
  cache.clear();
}
