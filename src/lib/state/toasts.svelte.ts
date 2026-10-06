export type ToastKind = "info" | "success" | "error" | "progress";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: { label: string; run: () => void };
  /** ms; 0 = sticky */
  timeout: number;
}

let seq = 0;

class Toasts {
  items = $state<Toast[]>([]);

  show(text: string, opts: Partial<Omit<Toast, "id" | "text">> = {}): number {
    const id = ++seq;
    const t: Toast = { id, text, kind: opts.kind ?? "info", action: opts.action, timeout: opts.timeout ?? 4000 };
    this.items = [...this.items.slice(-4), t];
    if (t.timeout > 0) setTimeout(() => this.dismiss(id), t.timeout);
    return id;
  }

  error(text: string) {
    return this.show(text, { kind: "error", timeout: 7000 });
  }

  update(id: number, patch: Partial<Omit<Toast, "id">>) {
    this.items = this.items.map((t) => (t.id === id ? { ...t, ...patch } : t));
    if (patch.timeout && patch.timeout > 0) setTimeout(() => this.dismiss(id), patch.timeout);
  }

  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new Toasts();
