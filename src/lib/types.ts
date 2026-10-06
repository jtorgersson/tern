// Shared types — mirror of the Rust structs in src-tauri/src/model.rs.
// Rust serializes with `#[serde(rename_all = "camelCase")]`.

export type ProviderKind = "microsoft";

export interface Account {
  id: string;
  provider: ProviderKind;
  email: string;
  displayName: string;
  /** Hue 0-360 used for the account dot / unified-inbox stripe. */
  hue: number;
  tenantId: string | null;
  lastSync: string | null; // ISO
  status: "ok" | "syncing" | "error" | "reauth";
  statusMessage: string | null;
}

export type WellKnownFolder =
  | "inbox"
  | "sentitems"
  | "drafts"
  | "archive"
  | "deleteditems"
  | "junkemail"
  | "outbox";

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  wellKnown: WellKnownFolder | null;
  parentId: string | null;
  unread: number;
  total: number;
}

export interface Addr {
  name: string;
  email: string;
}

export type AiCategory =
  | "needs_reply"
  | "action"
  | "fyi"
  | "calendar"
  | "newsletter"
  | "notification"
  | "receipt"
  | "spam";

export interface Annotation {
  messageId: string;
  category: AiCategory;
  /** 1 (low) – 3 (high) */
  priority: 1 | 2 | 3;
  /** One-line summary, <= 120 chars. */
  summary: string;
  actionItems: string[];
  needsReply: boolean;
  /** Optional ISO date when something is due. */
  dueAt: string | null;
  /** Reply Tern drafted ahead of time (plain text), for needs_reply mail. */
  suggestedReply: string | null;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  folderId: string;
  conversationId: string;
  subject: string;
  from: Addr;
  to: Addr[];
  preview: string;
  receivedAt: string; // ISO
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  importance: "low" | "normal" | "high";
  /** Set when the message is a meeting request/response (Graph eventMessage). */
  meetingType: MeetingType | null;
  ai: Annotation | null;
}

// ---- Calendar ----
export type MeetingType =
  | "meetingRequest"
  | "meetingCancelled"
  | "meetingAccepted"
  | "meetingTentativelyAccepted"
  | "meetingDeclined"
  | "none";

export type EventResponse = "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded";
export type ShowAs = "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";

export interface Attendee {
  addr: Addr;
  type: "required" | "optional" | "resource";
  response: EventResponse;
}

/**
 * Times are local wall-clock ISO strings WITHOUT offset ("2026-10-07T09:00:00") in `timeZone`
 * (the system zone at sync time), so `new Date(ev.start)` is correct on this machine.
 * All-day events use "YYYY-MM-DDT00:00:00" and `end` is the exclusive next midnight.
 */
export interface CalEvent {
  id: string;
  accountId: string;
  subject: string;
  start: string;
  end: string;
  timeZone: string;
  isAllDay: boolean;
  isCancelled: boolean;
  location: string | null;
  organizer: Addr | null;
  attendees: Attendee[];
  response: EventResponse;
  showAs: ShowAs;
  isOnline: boolean;
  joinUrl: string | null;
  webLink: string | null;
  preview: string;
  seriesMasterId: string | null;
  responseRequested: boolean;
}

export interface InviteInfo {
  meetingType: MeetingType;
  /** The calendar event the invitation refers to (null if it no longer exists). */
  event: CalEvent | null;
  /** Other non-declined, non-free events on the same account overlapping it. */
  conflicts: CalEvent[];
}

export type InviteAction = "accept" | "tentativelyAccept" | "decline";

export interface EventDraft {
  accountId: string;
  subject: string;
  start: string; // local wall-clock ISO, see CalEvent
  end: string;
  isAllDay?: boolean;
  location?: string | null;
  /** Plain text; Tern converts to HTML. */
  body?: string | null;
  attendees: Addr[];
  /** Create a Teams meeting link. */
  isOnline: boolean;
}

export interface FreeSlotQuery {
  accountId: string;
  /** Other people's emails to check (empty = just me). Uses getSchedule; personal accounts fall back to own calendar. */
  attendees: string[];
  from: string; // local ISO
  to: string;
  durationMins: number;
  /** "HH:MM" bounds; defaults from settings.calendar. */
  workStart?: string;
  workEnd?: string;
}

export interface FreeSlot {
  start: string;
  end: string;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  isInline: boolean;
  contentId: string | null;
}

export interface MessageFull extends MessageSummary {
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  /** Raw HTML body (cid: images already rewritten to data: URIs). Sanitize before rendering! */
  bodyHtml: string;
  /** Plain-text rendition (best effort) for AI use. */
  bodyText: string;
  attachments: Attachment[];
  webLink: string | null;
}

export type MessageView =
  | { kind: "today" } // briefing / proactive view (no list query)
  | { kind: "agenda" } // 7-day calendar agenda (no list query)
  | { kind: "folder"; folderId: string }
  | { kind: "unified"; wellKnown: WellKnownFolder } // across all accounts
  | { kind: "flagged" }
  | { kind: "category"; category: AiCategory } // inbox only, across accounts
  | { kind: "search"; query: string };

export interface MessageQuery {
  view: MessageView;
  /** Restrict to one account (optional). */
  accountId?: string | null;
  unreadOnly?: boolean;
  limit: number;
  /** Cursor: ISO receivedAt of the last item of the previous page. */
  before?: string | null;
}

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface OutgoingMessage {
  accountId: string;
  mode: ComposeMode;
  /** Required for reply / replyAll / forward. */
  refMessageId: string | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  bodyHtml: string;
}

export interface Contact {
  name: string;
  email: string;
  count: number;
}

export type AiProviderKind = "anthropic" | "openai";

export interface AiProvider {
  id: string;
  kind: AiProviderKind;
  name: string;
  /** For "openai": e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama). For anthropic: optional override. */
  baseUrl: string | null;
  /** Main model (agent, drafting). */
  model: string;
  /** Model for bulk triage. Falls back to `model`. */
  fastModel: string | null;
  /** True once an API key is stored in the keyring under `ai:<id>` (local servers may need none). */
  hasKey: boolean;
}

export interface Settings {
  microsoft: { clientId: string; tenant: string };
  ai: {
    providers: AiProvider[];
    defaultProviderId: string | null;
    triageProviderId: string | null;
    triageEnabled: boolean;
    /** Draft replies ahead of time for needs_reply mail (priority >= 2). */
    predraftReplies: boolean;
    /** Let the agent archive / mark read / flag without asking. Send & delete always ask. */
    autoApproveSafeActions: boolean;
    /** Free-text about the user ("I'm CEO at Emcap; keep replies short; Swedish with Swedes"). */
    aboutMe: string;
  };
  ui: {
    density: "comfortable" | "compact";
    remoteImages: "never" | "ask" | "always";
    /** How HTML mail renders: on a light "paper" card, or adapted to the dark theme. */
    mailRendering: "paper" | "adaptive";
    translucent: boolean;
  };
  signatures: Record<string, string>; // accountId -> html
  syncIntervalSecs: number;
  calendar: {
    /** Desktop notification this many minutes before a meeting (0 = off). */
    reminderMinutes: number;
    /** Working hours used for free-slot search, "HH:MM". */
    workStart: string;
    workEnd: string;
  };
}

export interface Theme {
  name: string;
  mode: "dark" | "light";
  /** Keys from Omarchy colors.toml: accent, background, foreground, color0..15, red, green, ... */
  colors: Record<string, string>;
  fontFamily: string | null;
  monoFamily: string | null;
}

export interface Bootstrap {
  accounts: Account[];
  settings: Settings;
  theme: Theme;
}

// ---- Events (listen via @tauri-apps/api/event) ----
export interface SyncStatusEvent {
  accountId: string;
  state: "idle" | "syncing" | "error" | "reauth";
  message: string | null;
  lastSync: string | null;
}
export interface MailChangedEvent {
  accountId: string;
  folderIds: string[];
  /** Newly arrived inbox message ids (for triage + notifications). */
  newMessageIds: string[];
}
export interface AuthProgressEvent {
  state: "waiting_browser" | "exchanging" | "done" | "error";
  message: string | null;
}

export const EVENTS = {
  syncStatus: "sync://status",
  mailChanged: "mail://changed",
  themeChanged: "theme://changed",
  authProgress: "auth://progress",
  accountsChanged: "accounts://changed",
  calendarChanged: "calendar://changed", // payload: { accountId }
} as const;
