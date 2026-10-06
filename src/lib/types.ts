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
  ai: Annotation | null;
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
} as const;
