// Pop-out windows: a message in its own window (same SPA, booted with `?message=<id>`).
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Stable window label per message, so opening it twice focuses the existing window. */
function labelFor(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return `msg-${(h >>> 0).toString(36)}`;
}

/** The message id when this webview is a pop-out message window. */
export function messageWindowId(): string | null {
  try {
    return new URLSearchParams(location.search).get("message");
  } catch {
    return null;
  }
}

export async function openMessageWindow(id: string, title?: string): Promise<void> {
  const label = labelFor(id);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const w = new WebviewWindow(label, {
      url: `/?message=${encodeURIComponent(id)}`,
      title: title?.trim() || "Tern",
      width: 940,
      height: 880,
      minWidth: 480,
      minHeight: 360,
      decorations: false,
      transparent: true,
      dragDropEnabled: false,
    });
    w.once("tauri://created", () => resolve());
    w.once<string>("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
}
