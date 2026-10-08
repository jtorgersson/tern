// Global keyboard map. Single-key shortcuts are ignored while typing.
import { app } from "$lib/state/app.svelte";
import { composer } from "$lib/state/composer.svelte";
import { connect } from "$lib/state/connect.svelte";
import { calendar } from "$lib/state/calendar.svelte";

export interface Shortcut {
  keys: string;
  label: string;
  group: "Navigate" | "Act" | "Compose" | "AI" | "App";
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "j / k", label: "Next / previous message", group: "Navigate" },
  { keys: "Enter / o", label: "Open message", group: "Navigate" },
  { keys: "O / Shift Enter", label: "Open message in its own window", group: "Navigate" },
  { keys: "p", label: "Show / hide the reading pane", group: "App" },
  { keys: "g t", label: "Go to Today", group: "Navigate" },
  { keys: "g b", label: "Toggle Connect beside mail / calendar", group: "Navigate" },
  { keys: "g c", label: "Go to Calendar", group: "Navigate" },
  { keys: "d / w / m / a / i", label: "Calendar: day / week / month / agenda / insights", group: "Navigate" },
  { keys: "[ / ]", label: "Calendar: move selected event a day back / forward", group: "Act" },
  { keys: "z", label: "Snooze", group: "Act" },
  { keys: "g z", label: "Go to Snoozed", group: "Navigate" },
  { keys: "g j", label: "Join the current / next meeting", group: "App" },
  { keys: "h / l", label: "Calendar: previous / next period", group: "Navigate" },
  { keys: "t", label: "Calendar: today", group: "Navigate" },
  { keys: "n", label: "Calendar: new event", group: "Compose" },
  { keys: "e", label: "Calendar: edit event", group: "Act" },
  { keys: "↑ ↓ ← →", label: "Calendar: move the time cursor (Shift+↑↓ resizes, Enter creates)", group: "Navigate" },
  { keys: "g i", label: "Go to inbox", group: "Navigate" },
  { keys: "g s", label: "Go to sent", group: "Navigate" },
  { keys: "g d", label: "Go to drafts", group: "Navigate" },
  { keys: "g a", label: "Go to archive", group: "Navigate" },
  { keys: "g f", label: "Go to flagged", group: "Navigate" },
  { keys: "g r", label: "Go to Needs reply", group: "Navigate" },
  { keys: "/", label: "Search", group: "Navigate" },
  { keys: "Esc", label: "Close / back", group: "Navigate" },
  { keys: "e", label: "Archive", group: "Act" },
  { keys: "#", label: "Delete", group: "Act" },
  { keys: "s", label: "Flag / unflag", group: "Act" },
  { keys: "u", label: "Toggle read", group: "Act" },
  { keys: "x", label: "Select for bulk action", group: "Act" },
  { keys: "U", label: "Unread only", group: "Act" },
  { keys: "c", label: "Compose", group: "Compose" },
  { keys: "r", label: "Reply", group: "Compose" },
  { keys: "R", label: "Reply all", group: "Compose" },
  { keys: "f", label: "Forward", group: "Compose" },
  { keys: "Ctrl Enter", label: "Send", group: "Compose" },
  { keys: "Ctrl J", label: "Ask Tern (agent)", group: "AI" },
  { keys: "t", label: "Summarize thread", group: "AI" },
  { keys: "Ctrl K", label: "Command palette", group: "App" },
  { keys: "Ctrl ,", label: "Settings", group: "App" },
  { keys: "Ctrl R", label: "Sync now", group: "App" },
  { keys: "?", label: "Keyboard shortcuts", group: "App" },
];

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** Events the reader listens to (decoupled from this module). */
export const readerBus = new EventTarget();

let pendingG = false;
let gTimer: ReturnType<typeof setTimeout> | undefined;

/** A pop-out message window: actions on its one message, Esc closes it. */
function handleMessageWindowKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (app.snoozeTarget) app.snoozeTarget = null;
    else if (composer.open && !composer.minimized && (!isTyping(e) || (e.target as HTMLElement).closest("[data-composer]"))) {
      (e.target as HTMLElement).blur?.();
      composer.minimized = true;
    } else if (isTyping(e)) (e.target as HTMLElement).blur();
    else import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
    return;
  }
  if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || app.snoozeTarget) return;
  const m = app.open;
  if (!m) return;
  const actions: Record<string, () => void> = {
    e: () => app.archive([m.id]),
    "#": () => app.trash([m.id]),
    Delete: () => app.trash([m.id]),
    s: () => app.toggleFlag([m.id]),
    u: () => app.toggleRead([m.id]),
    z: () => app.openSnooze([m.id]),
    c: () => composer.compose(),
    r: () => composer.reply(m, "reply"),
    R: () => composer.reply(m, "replyAll"),
    f: () => composer.reply(m, "forward"),
    t: () => readerBus.dispatchEvent(new Event("summarize")),
  };
  const fn = actions[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
}

/** Reply / forward the open message, or the selected one when the reading pane is hidden. */
async function replyTo(mode: "reply" | "replyAll" | "forward") {
  const m = await app.current();
  if (m) composer.reply(m, mode);
}

export function handleKey(e: KeyboardEvent) {
  if (app.windowKind === "message") return handleMessageWindowKey(e);
  const mod = e.ctrlKey || e.metaKey;

  // ---- global chords (work while typing) ----
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    app.paletteOpen = !app.paletteOpen;
    return;
  }
  if (mod && e.key.toLowerCase() === "j") {
    e.preventDefault();
    app.toggleAgent();
    return;
  }
  if (mod && e.key === ",") {
    e.preventDefault();
    app.openSettings();
    return;
  }
  if (mod && e.key.toLowerCase() === "r" && !e.shiftKey) {
    e.preventDefault();
    app.syncNow();
    return;
  }
  if (e.key === "Escape" && (e.target as HTMLElement | null)?.closest("[data-connect]")) {
    (e.target as HTMLElement).blur?.();
    pendingG = false;
    return;
  }
  if (e.key === "Escape") {
    if (app.snoozeTarget) app.snoozeTarget = null;
    else if (app.paletteOpen) app.paletteOpen = false;
    else if (app.cheatsheetOpen) app.cheatsheetOpen = false;
    else if (app.settingsOpen) app.settingsOpen = false;
    else if (composer.open && !composer.minimized && (!isTyping(e) || (e.target as HTMLElement).closest("[data-composer]"))) {
      (e.target as HTMLElement).blur?.();
      composer.minimized = true;
    }
    else if (calendar.composerOpen && (!isTyping(e) || (e.target as HTMLElement).closest("[data-event-composer]"))) {
      (e.target as HTMLElement).blur?.();
      calendar.closeComposer();
    }
    else if (calendar.detailsId && !isTyping(e)) calendar.openDetails(null);
    else if (calendar.cursor && !isTyping(e)) calendar.cursor = null;
    else if (app.agentOpen && !isTyping(e)) app.agentOpen = false;
    else if (isTyping(e)) (e.target as HTMLElement).blur();
    else if (app.checked.size) app.checked = new Set();
    else if (app.view.kind === "search" || app.view.kind === "results")
      app.setView({ kind: "unified", wellKnown: "inbox" });
    return;
  }

  // Keep conversation keyboard input from acting on the mail/calendar pane behind it.
  if ((e.target as HTMLElement | null)?.closest("[data-connect]") || (connect.open && connect.expanded)) {
    if (isTyping(e) || mod || e.altKey || app.paletteOpen || app.settingsOpen) return;
    if (pendingG) {
      pendingG = false;
      clearTimeout(gTimer);
      if (e.key === "b") { e.preventDefault(); connect.toggle(); }
    } else if (e.key === "g") {
      pendingG = true;
      gTimer = setTimeout(() => pendingG = false, 900);
    }
    return;
  }

  // AltGr (Ctrl+Alt on Windows, Option on macOS) is how Nordic layouts type [ and ]: let those through.
  const altGrBracket = (e.key === "[" || e.key === "]") && (e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey) || (e.altKey && !e.ctrlKey && !e.metaKey));
  if (isTyping(e) || ((mod || e.altKey) && !altGrBracket)) return;
  if (app.paletteOpen || app.settingsOpen || app.snoozeTarget || !app.hasAccounts) return;

  if (pendingG) {
    pendingG = false;
    clearTimeout(gTimer);
    const map: Record<string, () => void> = {
      i: () => app.setView({ kind: "unified", wellKnown: "inbox" }),
      s: () => app.setView({ kind: "unified", wellKnown: "sentitems" }),
      d: () => app.setView({ kind: "unified", wellKnown: "drafts" }),
      a: () => app.setView({ kind: "unified", wellKnown: "archive" }),
      t: () => app.setView({ kind: "today" }),
      c: () => app.setView({ kind: "calendar" }),
      b: () => connect.toggle(),
      z: () => app.setView({ kind: "snoozed" }),
      j: () => calendar.joinNext(),
      x: () => app.setView({ kind: "unified", wellKnown: "deleteditems" }),
      f: () => app.setView({ kind: "flagged" }),
      r: () => app.setView({ kind: "category", category: "needs_reply" }),
    };
    if (map[e.key]) {
      e.preventDefault();
      map[e.key]();
    }
    return;
  }

  if (app.view.kind === "calendar") {
    const sel = calendar.selected;
    const grid = calendar.view === "day" || calendar.view === "week";
    const cal: Record<string, () => void> = {
      j: () => calendar.moveSelection(1),
      k: () => calendar.moveSelection(-1),
      // Arrows drive the time cursor on the grid; elsewhere they page through events.
      ArrowDown: () => (grid ? calendar.moveCursor(0, 30, e.shiftKey) : calendar.moveSelection(1)),
      ArrowUp: () => (grid ? calendar.moveCursor(0, -30, e.shiftKey) : calendar.moveSelection(-1)),
      Enter: () => {
        if (grid && calendar.cursor && !calendar.detailsId) calendar.composeAtCursor();
        else if (calendar.selectedId) calendar.openDetails(calendar.detailsId ? null : calendar.selectedId);
      },
      o: () => calendar.selectedId && calendar.openDetails(calendar.selectedId),
      n: () => calendar.openComposer(),
      c: () => composer.compose(),
      e: () => sel && calendar.openEditor(sel),
      "#": () => sel && calendar.requestDelete(sel),
      Delete: () => sel && calendar.requestDelete(sel),
      d: () => calendar.setView("day"),
      w: () => calendar.setView("week"),
      m: () => calendar.setView("month"),
      a: () => calendar.setView("agenda"),
      i: () => calendar.setView("insights"),
      "]": () => sel && calendar.reschedule(sel, "tomorrow"),
      "[": () => sel && calendar.reschedule(sel, "prevDay"),
      h: () => calendar.prev(),
      ArrowLeft: () => (grid && calendar.cursor ? calendar.moveCursor(-1, 0) : calendar.prev()),
      l: () => calendar.next(),
      ArrowRight: () => (grid && calendar.cursor ? calendar.moveCursor(1, 0) : calendar.next()),
      t: () => calendar.today(),
      "/": () => calendar.searchFocusTick++,
      "?": () => (app.cheatsheetOpen = !app.cheatsheetOpen),
      g: () => {
        pendingG = true;
        gTimer = setTimeout(() => (pendingG = false), 900);
      },
    };
    const fn = cal[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
    return;
  }

  const actions: Record<string, () => void> = {
    j: () => app.move(1),
    ArrowDown: () => app.move(1),
    k: () => app.move(-1),
    ArrowUp: () => app.move(-1),
    Enter: () => (e.shiftKey ? app.openInWindow() : app.openSelected()),
    o: () => app.openSelected(),
    O: () => app.openInWindow(),
    p: () => app.toggleReadingPane(),
    e: () => app.archive(),
    "#": () => app.trash(),
    Delete: () => app.trash(),
    s: () => app.toggleFlag(),
    u: () => app.toggleRead(),
    z: () => app.openSnooze(),
    U: () => app.toggleUnreadOnly(),
    x: () => app.selectedId && app.toggleCheck(app.selectedId),
    c: () => composer.compose(),
    r: () => replyTo("reply"),
    R: () => replyTo("replyAll"),
    f: () => replyTo("forward"),
    a: () => app.toggleAgent(true),
    t: () => readerBus.dispatchEvent(new Event("summarize")),
    "/": () => app.searchFocusTick++,
    "?": () => (app.cheatsheetOpen = !app.cheatsheetOpen),
    g: () => {
      pendingG = true;
      gTimer = setTimeout(() => (pendingG = false), 900);
    },
  };
  const fn = actions[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
}
