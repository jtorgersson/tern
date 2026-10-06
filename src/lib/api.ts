// Typed wrappers around the Rust commands (src-tauri/src/commands.rs).
// Tauri converts camelCase JS argument keys to snake_case Rust parameters.
import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
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
};
