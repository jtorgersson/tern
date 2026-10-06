// Typed wrappers around the Rust commands (src-tauri/src/commands.rs).
// Tauri converts camelCase JS argument keys to snake_case Rust parameters.
import { invoke } from "@tauri-apps/api/core";
import type {
  Availability,
  Account,
  CalEvent,
  Calendar,
  EditScope,
  EventDraft,
  EventFull,
  EventPatch,
  FreeSlot,
  FreeSlotQuery,
  InviteAction,
  InviteInfo,
  Annotation,
  Bootstrap,
  Contact,
  Folder,
  MessageFull,
  MessageQuery,
  MessageSummary,
  OutgoingMessage,
  Settings,
  Theme,
} from "./types";

export const api = {
  bootstrap: () => invoke<Bootstrap>("app_bootstrap"),
  theme: () => invoke<Theme>("theme_get"),

  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (settings: Settings) => invoke<Settings>("settings_set", { settings }),

  /** Secrets live in the system keyring (gnome-keyring). Keys: `ai:<providerId>`. */
  secretSet: (key: string, value: string | null) => invoke<void>("secret_set", { key, value }),
  secretGet: (key: string) => invoke<string | null>("secret_get", { key }),

  accounts: () => invoke<Account[]>("accounts_list"),
  /** Opens the system browser for Microsoft sign-in; resolves when done. Emits auth://progress. */
  addMicrosoftAccount: () => invoke<Account>("account_add_microsoft"),
  cancelAuth: () => invoke<void>("auth_cancel"),
  removeAccount: (accountId: string) => invoke<void>("account_remove", { accountId }),
  updateAccount: (accountId: string, patch: { displayName?: string; hue?: number }) =>
    invoke<Account>("account_update", { accountId, patch }),

  folders: (accountId?: string | null) => invoke<Folder[]>("folders_list", { accountId: accountId ?? null }),
  messages: (query: MessageQuery) => invoke<MessageSummary[]>("messages_list", { query }),
  /** Full message; fetches + caches the body from the server on first open. */
  message: (id: string) => invoke<MessageFull>("message_get", { id }),
  /** All cached messages in a conversation (any folder), oldest first, bodies loaded. */
  thread: (id: string) => invoke<MessageFull[]>("thread_get", { id }),

  setRead: (ids: string[], read: boolean) => invoke<void>("messages_set_read", { ids, read }),
  setFlag: (ids: string[], flagged: boolean) => invoke<void>("messages_set_flag", { ids, flagged }),
  /** destination: folder id, or well-known name ("archive", "inbox", "deleteditems", "junkemail"). */
  move: (ids: string[], destination: string) => invoke<void>("messages_move", { ids, destination }),
  /** Moves to Deleted Items (or hard-deletes if already there). */
  remove: (ids: string[]) => invoke<void>("messages_delete", { ids }),
  send: (message: OutgoingMessage) => invoke<void>("message_send", { message }),

  /** Saves to ~/Downloads and returns the path. */
  saveAttachment: (messageId: string, attachmentId: string) =>
    invoke<string>("attachment_save", { messageId, attachmentId }),

  syncNow: (accountId?: string | null) => invoke<void>("sync_now", { accountId: accountId ?? null }),

  contacts: (prefix: string, limit = 8) => invoke<Contact[]>("contacts_suggest", { prefix, limit }),

  // ---- AI metadata (the AI itself runs in the frontend, see src/lib/ai) ----
  annotationsSet: (items: Annotation[]) => invoke<void>("annotations_set", { items }),
  /** Recent inbox messages that have no annotation yet, newest first. */
  untriaged: (limit: number) => invoke<MessageSummary[]>("messages_untriaged", { limit }),
  /** Stores (or clears, with null) the pre-drafted reply on an existing annotation. */
  annotationSetReply: (messageId: string, text: string | null) =>
    invoke<void>("annotation_set_reply", { messageId, text }),
  /** Sent messages from the last `days` days whose conversation has no later reply from someone else. Newest first. */
  followups: (days = 14, limit = 50) => invoke<MessageSummary[]>("followups_list", { days, limit }),
  /** Inbox messages with a triage deadline, soonest first (includes overdue up to 7 days). */
  due: (limit = 20) => invoke<MessageSummary[]>("messages_due", { limit }),

  // ---- Calendar (cached window: 14 days back … 45 days ahead, refreshed every sync; other ranges on demand) ----
  /** Events with start < to and end > from (local ISO bounds), sorted by start. */
  calendarEvents: (from: string, to: string, accountId?: string | null) =>
    invoke<CalEvent[]>("calendar_events", { from, to, accountId: accountId ?? null }),
  /** Kick a calendar refresh now (resolves immediately; listen for calendar://changed). */
  calendarSync: () => invoke<void>("calendar_sync"),
  /** Invitation details for a meeting-request message; null if it isn't one. Fetches from Graph. */
  inviteGet: (messageId: string) => invoke<InviteInfo | null>("invite_get", { messageId }),
  /** `proposed` (tentative/decline only) sends a counter-proposal to the organizer. */
  inviteRespond: (accountId: string, eventId: string, action: InviteAction, comment: string | null, sendResponse = true, proposed: { start: string; end: string } | null = null) =>
    invoke<void>("invite_respond", { accountId, eventId, action, comment, sendResponse, proposedStart: proposed?.start ?? null, proposedEnd: proposed?.end ?? null }),
  /** Snooze until `until` (ISO with offset or Z); null wakes them now. Snoozed mail is marked read and hidden. */
  snooze: (ids: string[], until: string | null) => invoke<void>("messages_snooze", { ids, until }),
  snoozedCount: () => invoke<number>("snoozed_count"),
  /** RFC 8058 one-click unsubscribe using the link from the message's own headers. */
  unsubscribeOneClick: (messageId: string) => invoke<void>("unsubscribe_one_click", { messageId }),
  eventNoteGet: (eventId: string) => invoke<string | null>("event_note_get", { eventId }),
  /** Empty text deletes the note. */
  eventNoteSet: (eventId: string, text: string) => invoke<void>("event_note_set", { eventId, text }),
  /** Ids of events that have notes. */
  eventNotesIndex: () => invoke<string[]>("event_notes_index"),
  /** Per-person free/busy (scheduling assistant). Fails for personal Microsoft accounts. */
  availability: (accountId: string, emails: string[], from: string, to: string, interval = 30) =>
    invoke<Availability[]>("calendar_availability", { accountId, emails, from, to, interval }),
  /** Free-text search over every cached event (subject, place, people, notes), closest to now first. */
  calendarSearch: (query: string, limit = 40) => invoke<CalEvent[]>("calendar_search", { query, limit }),
  eventCreate: (draft: EventDraft) => invoke<CalEvent>("event_create", { draft }),
  freeSlots: (query: FreeSlotQuery) => invoke<FreeSlot[]>("calendar_free_slots", { query }),
  /** The user's calendars (all accounts unless filtered), default calendar first. */
  calendars: (accountId?: string | null) => invoke<Calendar[]>("calendar_list", { accountId: accountId ?? null }),
  /** Downloads [from, to) from the server into the cache and returns it. Max 400 days. */
  calendarFetchRange: (from: string, to: string, accountId?: string | null) =>
    invoke<CalEvent[]>("calendar_fetch_range", { from, to, accountId: accountId ?? null }),
  /** Full body + recurrence rule, fetched live. */
  eventGet: (accountId: string, eventId: string) => invoke<EventFull>("event_get", { accountId, eventId }),
  eventUpdate: (accountId: string, eventId: string, patch: EventPatch, scope: EditScope = "occurrence") =>
    invoke<CalEvent>("event_update", { accountId, eventId, patch, scope }),
  /** Deletes; when the user organizes a meeting with attendees it is cancelled (attendees notified, optional note). */
  eventDelete: (accountId: string, eventId: string, scope: EditScope = "occurrence", comment: string | null = null) =>
    invoke<void>("event_delete", { accountId, eventId, scope, comment }),
};
