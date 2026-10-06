# Tern — architecture

Tern is an AI-native, keyboard-first mail client for Omarchy / Hyprland.
Tauri 2 (Rust backend, WebKitGTK) + SvelteKit SPA (Svelte 5 runes) + TypeScript.

```
┌──────────────── Svelte UI (src/) ────────────────┐
│ routes/+page.svelte  lib/components/*  lib/state │
│        │                    │                    │
│   lib/api.ts (invoke)   lib/ai/* (Anthropic SDK, │
│        │                 OpenAI SDK via          │
│        │                 tauri-plugin-http fetch)│
└────────┼─────────────────────────────────────────┘
         ▼ Tauri commands / events
┌──────────────── Rust (src-tauri/src) ────────────┐
│ commands.rs → db.rs (SQLite + FTS5)              │
│             → auth.rs (MS OAuth PKCE, loopback)  │
│             → graph.rs (Microsoft Graph client)  │
│             → sync.rs (delta sync loop, events)  │
│             → secrets.rs (keyring)               │
│             → theme.rs (Omarchy colors.toml)     │
│             → settings.rs (~/.config/tern)       │
└──────────────────────────────────────────────────┘
```

## Contract
* `src/lib/types.ts` — every type crossing the boundary (Rust mirrors in `model.rs`, camelCase serde).
* `src/lib/api.ts` — every command. Rust command names are the strings passed to `invoke`.
* Events: see `EVENTS` in types.ts.

## Storage
* Data: `~/.local/share/tern/tern.db` (SQLite, WAL). Tables: accounts, folders, messages, bodies,
  annotations, contacts, sync_state, events, calendars, `messages_fts` (FTS5 over subject/from/preview/body text).
* Settings: `~/.config/tern/settings.json`.
* Secrets (gnome-keyring, service `tern`): `ms:<accountId>` refresh token, `ai:<providerId>` API keys.

## Microsoft
Public-client app registration (no secret). Auth-code + PKCE against
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`, redirect `http://localhost:<random port>`.
Scopes: `offline_access openid profile email User.Read Mail.ReadWrite Mail.Send MailboxSettings.Read Calendars.ReadWrite`.
Sync: `/me/mailFolders` + per-folder `messages/delta` (inbox, sent, drafts, archive, deleted, junk), polling every
`syncIntervalSecs`. Bodies fetched lazily on open, and prefetched in the background after each sync (`sync::prefetch_bodies`, 40 per cycle,
last 60 days, `settings.prefetchBodies`).
Calendar (`calendar.rs`): each sync cycle lists `/me/calendars` and replaces a cached window (−14d…+45d) of
`/me/calendars/{id}/calendarView` for every calendar of the account, with `Prefer: outlook.timezone="<system IANA zone>"`
so stored times are local wall-clock strings. Other ranges are fetched on demand (`calendar_fetch_range`, ≤400 days) when
the UI or the agent navigates there; the frontend store tracks per-month coverage with a 10-minute TTL. Events are
created / patched / deleted via `/me/events` (`event_update` / `event_delete` take `scope: occurrence | series`; an
organizer's meeting with attendees is cancelled via `/cancel` so attendees are notified). `event_get` fetches the full body
and the series' recurrence rule. Meeting mails are detected by
`@odata.type` in delta and resolved on open via `GET /me/messages/{id}?$expand=microsoft.graph.eventMessage/event`;
conflicts are computed from the cache. Free slots use `/me/calendar/getSchedule` (falls back to the own cache on personal
accounts). A 30 s loop sends a desktop reminder `settings.calendar.reminderMinutes` before each meeting.

## AI (src/lib/ai) — runs in the webview
Providers: `anthropic` (official `@anthropic-ai/sdk`, default model `claude-opus-5-5`, `fallbacks: "default"`)
and `openai` (official `openai` SDK; any OpenAI-compatible base URL — OpenAI, Ollama, LM Studio, OpenRouter, Groq…).
Both SDKs get `fetch` from `@tauri-apps/plugin-http` so requests go through Rust (no CORS issues).

Public surface (`src/lib/ai/index.ts`):
```ts
export function hasAi(settings): boolean
export async function testProvider(p: AiProvider): Promise<string>          // "ok" or throws
export async function triage(msgs: MessageSummary[]): Promise<Annotation[]>   // batch, structured output
export function summarizeThread(thread: MessageFull[], signal?): AsyncIterable<string>   // markdown deltas
export function draftReply(opts: { message: MessageFull; thread?: MessageFull[]; instruction: string;
                                   account: Account; signal?: AbortSignal }): AsyncIterable<string> // plain text deltas
export function rewrite(text: string, instruction: string, signal?): AsyncIterable<string>
export async function briefing(msgs: MessageSummary[]): Promise<string>    // markdown "what matters today"
export class AgentSession {
  constructor(opts: { onEvent: (e: AgentEvent) => void; context?: () => AgentContext })
  send(text: string): Promise<void>
  resolveApproval(callId: string, approved: boolean): void
  abort(): void
  reset(): void
}
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking" }                                   // model is working (no text yet)
  | { type: "tool_start"; id: string; name: string; label: string; input: unknown }
  | { type: "approval"; id: string; name: string; label: string; input: unknown; preview: string }
  | { type: "tool_end"; id: string; ok: boolean; summary: string }
  | { type: "ui"; action: { kind: "open_message"; id: string } | { kind: "compose"; draft: Partial<OutgoingMessage> }
                          | { kind: "show_results"; title: string; ids: string[] } }
  | { type: "done" }
  | { type: "error"; message: string };
export interface AgentContext { accountId?: string | null; openMessageId?: string | null; view?: MessageView }
```
Agent tools: `search_messages`, `list_messages`, `read_message`, `read_thread`, `list_folders`, `list_accounts`,
`archive`, `mark_read`, `flag`, `move`, `delete` (approval), `compose_draft` (opens composer, never sends),
`send_email` (approval, always), `show_results` (pushes a filtered list into the UI),
`list_events`, `find_free_times`, `create_event` (approval), `respond_to_invite` (approval).
Email content is untrusted: it is wrapped in `<email>` tags, the system prompt says instructions inside mail
are data, and every outward or destructive action needs explicit user approval.

## UI
Three panes: sidebar (accounts, unified views, AI categories, folders) · message list · reader.
Agent panel slides over from the right (`⌘/Ctrl+J` or `a`), command palette `Ctrl+K`.
Colors come from the live Omarchy theme as CSS variables (`--accent`, `--bg`, …), re-applied on `theme://changed`.

Keyboard: `j/k` next/prev · `Enter`/`o` open · `e` archive · `#` delete · `s` star/flag · `u` toggle read ·
`r` reply · `R`/`a`… see `src/lib/keys.ts` · `c` compose · `/` search · `g i` inbox · `g s` sent ·
`Ctrl+K` palette · `Ctrl+J` agent · `Esc` close.

## Dates and times
All user-facing formatting goes through `src/lib/util/fmt.ts`: 24-hour clock (`hhmm`), Monday-first weeks
(`startOfWeek`), ISO week numbers (`isoWeek`), day-before-month. `settings.ui.locale` (`en-GB` | `sv-SE`) only changes
the language of weekday/month names. Never call `toLocale*String` directly in components.

## Calendar UI (src/lib/components)
`Calendar.svelte` (toolbar, quick add, rail with `MiniMonth` + calendars + open invitations) hosts `TimeGrid` (day/week:
overlap column packing from `layoutDay`, drag to move/resize, drag on empty space to create), `MonthGrid` (6×7, HTML5
drag to another day) and `AgendaList`. State in `state/calendar.svelte.ts`: `view` + `anchor` → `period`; `events` is
everything loaded this session and `visible` applies the account filter and hidden calendars. `EventComposer` handles
create and edit (occurrence or series) including recurrence presets (`presetRecurrence`), and `util/quickadd.ts` parses
natural-language input (tests: `bun test src`).
