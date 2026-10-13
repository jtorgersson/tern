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

## External automation

`automation.rs` exposes a shared typed service through native `tern --mcp`
(stdio, Rust MCP SDK) and `tern --api [PORT]` (Axum HTTP, IPv4 loopback only).
The modes are selected before the desktop/single-instance runtime initializes.
They use the same `AppState`, SQLite WAL cache and Microsoft keyring credentials
as the desktop. MCP discovery and HTTP `GET /v1/tools` share schemas generated
with schemars; `POST /v1/{operation}` dispatches the same operations as MCP.
The HTTP middleware enforces bearer authentication, exact loopback Host,
no browser Origin, and a 1 MiB request limit. Tokens are user-provided through
`TERN_API_TOKEN` or generated into a mode-0600 config file.

Calendar reads can refresh the selected range live with per-account fallback
warnings. Mail search reads the desktop's cache and reports its source; bodies
load through the existing mail loader. Headless processes do not start the UI's
background sync or notifications. Connect wrappers delegate to shared service
functions, retaining account consent checks and bounded Graph pagination.
External mail/Teams sends use single-attempt POSTs; empty Microsoft 202/204
responses are successful. Draft creation is separate from sending. Event
creation includes a transaction ID for retry deduplication. Account checks,
ID encoding, local-time validation and pagination bounds are enforced in the
service, independent of client tool metadata. See [automation](docs/automation.md)
for the contract and installation/registration instructions.

## Contract
* `src/lib/types.ts` — every type crossing the boundary (Rust mirrors in `model.rs`, camelCase serde).
* `src/lib/api.ts` — mail/calendar commands; `src/lib/connect.ts` — Connect commands and Graph response types. Rust command names are the strings passed to `invoke`.
* Events: see `EVENTS` in types.ts.

## Storage
* Data: `~/.local/share/tern/tern.db` (SQLite, WAL). Tables: accounts, folders, messages, bodies,
  annotations, contacts, sync_state, events, calendars, snoozes, event_notes, `messages_fts` (FTS5 over subject/from/preview/body text).
* Settings: `~/.config/tern/settings.json`.
* Secrets (gnome-keyring, service `tern`): `ms:<accountId>` refresh token, `ai:<providerId>` API keys.

## Microsoft
Public-client app registration (no secret). Auth-code + PKCE against
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`, redirect `http://localhost:<random port>`.
Scopes: `offline_access openid profile email User.Read Mail.ReadWrite Mail.Send MailboxSettings.Read Calendars.ReadWrite`,
plus `Mail.ReadWrite.Shared Mail.Send.Shared Calendars.ReadWrite.Shared` once the user adds a shared mailbox (`accounts.shared_consent`).

Shared mailboxes and other people's calendars are accounts of their own with `owner_id` = the signed-in account whose
token opens them (`account_add_shared`; id `shared-<owner>-<address>`). `graph::scoped` rewrites their `/me/...` paths to
`/users/<address>/...` and `auth::access_token` resolves the owner's token, so sync, sending and calendar code is shared.
`sync_mail = 0` marks a calendar-only account (only the calendar syncs; a delegate without access to the calendar list
falls back to `/users/<address>/calendar`). Removing an account removes the shared ones opened through it. Shared calendars
never trigger reminders, and the UI's "my day" (next up, today, invitations, insights) uses `calendar.mine`, which leaves them out.
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

## Connect (Microsoft Teams)

`src-tauri/src/connect.rs` exposes `connect_enable`, `connect_list`, `connect_send`, `connect_people`, `connect_create_chat`, `connect_search`, and `connect_message`. A tagged resource enum builds Graph v1.0 chat, joined-team, channel, message, and reply paths; IDs are encoded as path segments. Pagination is restricted to HTTPS on graph.microsoft.com and the requested resource. Sends use `graph::call_once` so ambiguous errors do not cause duplicate posts. Tokens stay in Rust.

`accounts.connect_consent` is migrated with a false default. Enabling Connect requests delegated `Chat.Read ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send` alongside existing mail/calendar (and previously granted shared) scopes. Consent checks the returned user and tenant against the selected account before saving credentials. Refreshes retain granted scopes; normal account addition still uses base mail/calendar scopes only. Shared mailboxes and personal Microsoft accounts cannot enable Connect.

`Connect.svelte` owns the independently selected account, browser, conversation, thread, pagination, and in-memory drafts keyed by account and conversation. Request generations discard stale responses after navigation or account changes. Message HTML uses a small DOMPurify allowlist, remote images are omitted, and links open through the system opener with HTTPS validation. Drafts and conversation state survive hiding the dock because it stays mounted; polling pauses while hidden or when the document is not visible. The active conversation polls every 15 seconds and the list every 60 seconds. There is no Teams offline cache or Graph webhook subscription.

`state/connect.svelte.ts` persists only dock visibility and width in localStorage. The dock occupies a sibling pane beside the existing mail/calendar grid; expanding it hides that grid without destroying it. Keyboard events from the dock are excluded from mail/calendar single-key actions. Toolbar, sidebar, command palette, and `g b` toggle the dock. Calls and attachments hand off to Teams.

`accounts.connect_compose_consent` separately records the `Chat.Create User.ReadBasic.All` upgrade. Existing Connect accounts retain their original scopes until they reconnect; the directory and creation endpoints require upgraded consent. Directory queries escape OData literals and encode query parameters, return up to 20 matches, and exclude the current user in the UI. Creation validates UUIDs, resolves profiles server-side, deduplicates members including the current user, uses guest roles where Graph reports a guest, and sends a single POST. One-to-one creation reuses existing chats; group creation supports up to 20 other people. The person picker never sends an initial message automatically.

`ConnectAssistant.svelte` streams through `writeConnect` and the existing provider abstraction. Generated output lives in a preview until explicitly accepted; the editable draft stays unchanged while generating. Conversation changes abort the stream. The prompt treats all messages, drafts, and email as untrusted context, bounds history to 40 non-deleted messages / 18,000 characters, and includes the open email only when opted in. `ConversationBrief.svelte` uses the same pipeline in JSON brief mode. `util/connect-experience.ts` captures up to 40 complete, non-deleted, non-system messages within an 18,000-character budget, validates card kinds and source IDs against that snapshot, and rejects malformed responses. Brief cards navigate to local sources; handoffs append to the current reply draft or prefill an event draft. A changed source snapshot exposes a refresh hint. Both components abort generation on conversation changes. Conversation/email handoffs preserve existing composer drafts and use participant addresses from the chat (members are fetched for search-opened chats).

`state/search.svelte.ts` owns unified search independently of mail/calendar navigation. It fans out local message search, account-filtered cached event search, and `/search/query` for the `chatMessage` entity in each enabled account. Request generations isolate obsolete searches; errors and pagination are per source/account. `GlobalSearch.svelte` renders escaped previews and source tabs. Graph search hits are mapped to chat/channel/thread resources; `connect_message` fetches older hits outside the first loaded page. `connect.request` is the account-aware bridge used by both search and the mail reader. Global search keyboard handling suppresses actions on content behind the results.

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
`settings.ui.contrast` (`theme` | `higher` | `highest`, `applyTheme`) pulls the background towards a neutral near-black (white
in light themes), lifts `--fg-dim` / `--muted` towards the foreground, firms up `--line` and makes translucent windows more opaque.
`settings.ui.readingPane: "off"` hides the reader (`p` toggles); Enter then opens the message in its own window.
Pop-out message windows (`O`, Shift+Enter, double-click, toolbar) are the same SPA booted with `?message=<id>`
(`util/windows.ts`, label `msg-<hash>`, `app.initMessageWindow`); they emit `mail://changed` after actions so the main
window refreshes, and close themselves once the message is archived, deleted or snoozed.

Keyboard: `j/k` next/prev · `Enter`/`o` open · `e` archive · `v` move · `#` delete · `s` star/flag · `u` toggle read ·
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

## Mail extras
* Attachments out: `OutgoingMessage.attachments[]` (name, contentType, base64 `data`; the composer reads files with
  `FileReader`, drop/paste included). With files, `graph::send_new` creates a draft (`POST /me/messages`) instead of
  `sendMail`; replies already go through a draft. `attach_all` posts ≤3 MB files inline as `fileAttachment` and
  larger ones through `createUploadSession` in 3.75 MB chunks (`upload_large`), then `/send`; a failure deletes the draft.
  Limits: 25 MB per file / 40 MB per mail in the UI, 50 MB per file in Rust.
* Attachments in: `attachment_open` downloads once into `~/.cache/tern/attachments/<hash>/<name>` and returns the path
  (opened with the system opener); `attachment_preview` returns a `data:` URL for images ≤ 6 MB (thumbnails).
* Draft autosave: the composer writes the draft (minus the `ref` message) to `localStorage["tern.draft"]` 500 ms after
  each change (attachment bytes only up to 2 MB total); `composer.restore()` on boot brings it back minimized.
  `discard()` closes with an Undo toast. Autosave is main-window only.
* Search operators: `db::parse_search` (tested) turns `from: to: subject: has:attachment is:unread|read|flagged
  in:<folder> before: after: newer: older:` (Swedish aliases too, quoted values ok) into SQL filters; the remaining words
  go to FTS. Operator-only searches skip junk and trash unless `in:` says otherwise.
* Person card: `person_summary(email)` → `PersonSummary` (counts both directions, first/last contact, latest mail from
  them, `waiting` = `followups` filtered to them, `unanswered` = inbox mail from them without a reply, 60 days).
  `PersonCard.svelte` adds upcoming meetings from the cached calendar and an on-demand AI brief (`personBrief`).
* Reader: `util/html.ts` `collapseQuotedText` folds the quoted earlier conversation (Gmail/Outlook/Apple/Thunderbird
  markers, Outlook "From:/Sent:/Subject:" headers, "… wrote:" before a blockquote) behind a toggle button inside the
  srcdoc; `MailFrame` handles the click (the iframe has no scripts) and reports hovered links to the reader's link bar.
  `app.readerScale` (localStorage) becomes `body{zoom}` in the srcdoc.
* Move to folder: `app.moveTarget` + `FolderPicker.svelte` (well-known folders by name, the message's own account's
  folders by id; several accounts → standard folders only) → `app.moveTo` with the existing Undo toast.
* Snooze: `snoozes(message_id, until UTC)`. `Db::list` hides snoozed rows from every view except Search and
  `{kind:"snoozed"}`. Snoozing marks read; `sync::start_snooze_waker` (20 s loop) marks them unread again, emits
  `mail://changed` + `snooze://woke` and shows a notification.
* Send later: `OutgoingMessage.sendAt` (UTC) becomes `singleValueExtendedProperties` `SystemTime 0x3FEF`
  (PidTagDeferredSendTime) on `sendMail` or on the reply draft before `/send`; Exchange holds it in the Outbox.
* Unsubscribe: `internetMessageHeaders` are read with the body (or once on open for older cached bodies) and
  `List-Unsubscribe` / `List-Unsubscribe-Post` parsed into `bodies.unsubscribe_json`. One-click POSTs only to the URL
  stored from the headers, never to one supplied by the UI.

## Calendar extras
* `event_notes(event_id, text)` are local only. Insights are computed client-side in `util/insights.ts` (tested) from
  cached events; the view's period is 12 weeks so `ensurePeriod` downloads the history it needs.
* Scheduling assistant: `calendar_availability` returns per-person getSchedule views (30-min slots); personal accounts
  get an explanatory message.
