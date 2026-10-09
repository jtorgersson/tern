import { readCursor, type Conversation } from "$lib/connect";
import { parsePins, pinKey, type PinnedConversation } from "$lib/util/pins";
/** Dock state is independent of mail/calendar navigation. */
class ConnectState {
  pins = $state<PinnedConversation[]>([]);
  isPinned(accountId: string, resource: Conversation["resource"]) {
    const key = pinKey(accountId, resource);
    return !!key && this.pins.some(p => pinKey(p.accountId, p.conversation.resource) === key);
  }
  togglePin(accountId: string, conversation: Conversation) {
    const key = pinKey(accountId, conversation.resource);
    if (!key) return;
    this.pins = this.isPinned(accountId, conversation.resource)
      ? this.pins.filter(p => pinKey(p.accountId, p.conversation.resource) !== key)
      : [...this.pins, { accountId, conversation: { title: conversation.title, resource: conversation.resource } }];
    this.savePins();
  }
  removeAccount(accountId: string) {
    this.pins = this.pins.filter(p => p.accountId !== accountId);
    this.savePins();
  }
  private savePins() {
    try { localStorage.setItem("tern.connect.pins", JSON.stringify(this.pins)); } catch {}
  }
  request = $state<{
    accountId: string;
    conversation?: Conversation;
    messageId?: string;
    recipient?: string;
    draft?: string;
  } | null>(null);
  show(request: NonNullable<ConnectState["request"]>) {
    this.open = true;
    this.expanded = false;
    this.request = request;
    try { localStorage.setItem("tern.connect.open", "true"); } catch {}
  }
  open = $state(false);
  expanded = $state(false);
  width = $state(480);
  /** Account-scoped cursors for reading in Tern; Teams' own read receipts are untouched. */
  read = $state<Record<string, string>>({});
  readKey(accountId: string, resource: Conversation["resource"]) {
    return JSON.stringify([accountId, resource]);
  }
  markRead(accountId: string, resource: Conversation["resource"], at: string) {
    const key = this.readKey(accountId, resource);
    if (readCursor(at) <= readCursor(this.read[key])) return;
    this.read[key] = at;
    try { localStorage.setItem("tern.connect.read", JSON.stringify(this.read)); } catch {}
  }
  constructor() {
    try { this.pins = parsePins(localStorage.getItem("tern.connect.pins") || "[]"); } catch {}
    try {
      this.open = localStorage.getItem("tern.connect.open") === "true";
      this.width = Math.max(360, Math.min(900, Number(localStorage.getItem("tern.connect.width")) || 480));
      const saved = JSON.parse(localStorage.getItem("tern.connect.read") || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        this.read = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1]))));
      }
    } catch {}
  }
  toggle() {
    this.open = !this.open;
    this.expanded = false;
    try { localStorage.setItem("tern.connect.open", String(this.open)); } catch {}
  }
  saveWidth() {
    try { localStorage.setItem("tern.connect.width", String(this.width)); } catch {}
  }
}
export const connect = new ConnectState();
