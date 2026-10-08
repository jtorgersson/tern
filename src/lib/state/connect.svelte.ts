/** Dock state is independent of mail/calendar navigation. */
class ConnectState {
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
