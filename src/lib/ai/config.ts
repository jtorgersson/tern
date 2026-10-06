// Settings access + provider/model resolution for the AI layer.
import type { AiProvider, Settings } from "../types";

let getSettingsFn: (() => Settings) | null = null;

/** Call once from the UI with a getter returning the current settings. */
export function configureAi(getSettings: () => Settings): void {
  getSettingsFn = getSettings;
}

export function settings(): Settings {
  if (!getSettingsFn) throw new Error("AI not configured: call configureAi() first");
  return getSettingsFn();
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export type Purpose = "main" | "fast";

export interface Resolved {
  provider: AiProvider;
  model: string;
}

/** True when at least one provider is configured and usable. */
export function hasAi(s: Settings): boolean {
  return pickProvider(s, "main") !== null;
}

function pickProvider(s: Settings, purpose: Purpose): AiProvider | null {
  const ps = s.ai.providers;
  if (!ps.length) return null;
  const byId = (id: string | null) => (id ? ps.find((p) => p.id === id) ?? null : null);
  const usable = (p: AiProvider | null) =>
    p && (p.hasKey || (p.kind === "openai" && !!p.baseUrl)) ? p : null;
  const preferred =
    purpose === "fast"
      ? usable(byId(s.ai.triageProviderId)) ?? usable(byId(s.ai.defaultProviderId))
      : usable(byId(s.ai.defaultProviderId));
  return preferred ?? ps.map(usable).find((p) => p) ?? null;
}

export function resolve(purpose: Purpose = "main"): Resolved {
  const s = settings();
  const provider = pickProvider(s, purpose);
  if (!provider) throw new Error("No AI provider configured. Add one in Settings → AI.");
  const fallback = provider.kind === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "gpt-4o-mini";
  const model =
    (purpose === "fast" ? provider.fastModel || provider.model : provider.model) || fallback;
  return { provider, model };
}
