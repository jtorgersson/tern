import type { Conversation } from "$lib/connect";
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
  constructor() {
    try {
      this.open = localStorage.getItem("tern.connect.open") === "true";
      this.width = Math.max(360, Math.min(900, Number(localStorage.getItem("tern.connect.width")) || 480));
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
