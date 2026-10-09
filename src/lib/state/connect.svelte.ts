import { readCursor, type Conversation } from "$lib/connect";
/** Dock state is independent of mail/calendar navigation. */
class ConnectState {
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
