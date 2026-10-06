// Map SDK errors from either provider to short, user-facing messages.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiProvider } from "../types";

export class AiError extends Error {}

export function isAbort(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof OpenAI.APIUserAbortError ||
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export function friendlyError(err: unknown, provider?: AiProvider): string {
  const who = provider ? provider.name : "the AI provider";
  if (err instanceof AiError) return err.message;
  if (isAbort(err)) return "Cancelled.";
  // Anthropic
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError)
    return `API key rejected for ${who}. Check it in Settings → AI.`;
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof OpenAI.PermissionDeniedError)
    return `${who} denied access to this model or feature.`;
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError)
    return `${who}: model or endpoint not found. Check the model name and base URL.`;
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError)
    return `${who} is rate limiting requests. Try again in a moment.`;
  if (err instanceof Anthropic.BadRequestError || err instanceof OpenAI.BadRequestError)
    return `${who} rejected the request: ${shortMsg(err)}`;
  if (err instanceof Anthropic.InternalServerError || err instanceof OpenAI.InternalServerError)
    return `${who} had a server error (${(err as { status?: number }).status ?? "5xx"}). Try again.`;
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError)
    return `Couldn't reach ${who}. Check your connection${provider?.baseUrl ? ` and ${provider.baseUrl}` : ""}.`;
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError)
    return `${who} error: ${shortMsg(err)}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function shortMsg(err: Error): string {
  const m = err.message || "unknown error";
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}
