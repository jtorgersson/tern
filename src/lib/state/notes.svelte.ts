// Notes library: capture, OneDrive, categories, search.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "$lib/api";
import type { ImportReport, Note, NoteFacet, NoteQuery } from "$lib/types";
import { toasts } from "./toasts.svelte";
import { errMsg } from "$lib/util/misc";

class NotesState {
  items = $state<Note[]>([]);
  facets = $state<NoteFacet[]>([]);
  total = $state(0);
  archivedCount = $state(0);
  unanalyzed = $state(0);
  category = $state<string | null>(null);
  kind = $state<"text" | "image" | null>(null);
  sort = $state<"updated" | "created" | "title">("updated");
  archived = $state(false);
  q = $state("");
  selectedId = $state<string | null>(null);
  selected = $state<Note | null>(null);
  loading = $state(false);
  importing = $state(false);
  captureOpen = $state(false);
  searchTick = $state(0);
  hasMore = $state(false);
  error = $state("");
  revision = $state("");

  private offset = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: UnlistenFn | null = null;

  query(extra: Partial<NoteQuery> = {}): NoteQuery {
    return {
      q: this.q.trim() || null,
      category: this.archived ? null : this.category,
      kind: this.kind,
      archived: this.archived,
      sort: this.sort,
      limit: 48,
      offset: this.offset,
      ...extra,
    };
  }

  async ensureListening() {
    if (this.unlisten) return;
    this.unlisten = await listen("notes://changed", () => this.refreshIfChanged());
  }

  async load(opts: { append?: boolean; silent?: boolean } = {}) {
    if (!opts.append) this.offset = 0;
    if (!opts.silent) this.loading = true;
    this.error = "";
    try {
      await this.ensureListening();
      const page = await api.notesList(this.query());
      this.items = opts.append ? [...this.items, ...page.notes] : page.notes;
      this.facets = page.facets;
      this.total = page.total;
      this.archivedCount = page.archived;
      this.unanalyzed = page.unanalyzed;
      this.revision = page.revision;
      this.hasMore = this.items.length < page.total;
      if (this.selectedId && !opts.append && !this.items.some((n) => n.id === this.selectedId) && !this.selected) {
        this.selectedId = null;
      }
    } catch (e) {
      this.error = errMsg(e);
    } finally {
      this.loading = false;
    }
  }

  async loadMore() {
    if (!this.hasMore || this.loading) return;
    this.offset = this.items.length;
    await this.load({ append: true, silent: true });
  }

  async refreshIfChanged() {
    try {
      const rev = await api.notesRevision();
      if (rev !== this.revision) await this.load({ silent: true });
    } catch {
      /* the library will refresh on the next visit */
    }
  }

  setQuery(q: string) {
    this.q = q;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(), 160);
  }

  async setCategory(category: string | null) {
    this.archived = false;
    this.category = category;
    this.selectedId = null;
    this.selected = null;
    await this.load();
  }

  async showArchive() {
    this.archived = true;
    this.category = null;
    this.selectedId = null;
    this.selected = null;
    await this.load();
  }

  async setKind(kind: "text" | "image" | null) {
    this.kind = kind;
    await this.load();
  }

  async setSort(sort: "updated" | "created" | "title") {
    this.sort = sort;
    await this.load();
  }

  async select(id: string | null) {
    this.selectedId = id;
    if (!id) {
      this.selected = null;
      return;
    }
    try {
      this.selected = await api.note(id);
    } catch (e) {
      this.error = errMsg(e);
    }
  }

  move(delta: number) {
    if (!this.items.length) return;
    const idx = this.items.findIndex((n) => n.id === this.selectedId);
    const next = idx < 0 ? 0 : Math.max(0, Math.min(this.items.length - 1, idx + delta));
    const id = this.items[next]?.id;
    if (id && id !== this.selectedId) this.select(id);
  }

  startCapture() {
    this.captureOpen = true;
  }

  focusSearch() {
    this.searchTick++;
  }

  async create(body: string) {
    const note = await api.notesCreate({ body, source: "capture" });
    this.captureOpen = false;
    await this.load({ silent: true });
    await this.select(note.id);
    return note;
  }

  async save(draft: { id: string; title: string; body: string; category: string; tags: string[] }) {
    const note = await api.notesUpdate(draft);
    this.selected = note;
    this.items = this.items.map((n) => (n.id === note.id ? { ...n, ...note, body: "" } : n));
    return note;
  }

  async togglePin(id = this.selectedId) {
    if (!id) return;
    const note = this.items.find((n) => n.id === id) ?? this.selected;
    if (!note) return;
    const next = await api.notesMeta({ id, pinned: !note.pinned });
    if (this.selected?.id === id) this.selected = next;
    await this.load({ silent: true });
  }

  async archiveSelected() {
    const id = this.selectedId;
    if (!id) return;
    const note = this.selected;
    await api.notesMeta({ id, archived: !this.archived });
    this.selectedId = null;
    this.selected = null;
    await this.load({ silent: true });
    if (note && !this.archived) {
      toasts.show(`Archived “${note.title}”`, {
        action: { label: "Undo", run: () => api.notesMeta({ id, archived: false }).then(() => this.load({ silent: true })) },
      });
    }
  }

  async deleteSelected() {
    const note = this.selected;
    if (!note) return;
    const snapshot = note;
    await api.notesDelete(note.id);
    this.selectedId = null;
    this.selected = null;
    await this.load({ silent: true });
    toasts.show(`Deleted “${snapshot.title}”`, {
      timeout: 6000,
      action: {
        label: "Undo",
        run: () =>
          api
            .notesCreate({
              title: snapshot.title,
              body: snapshot.body,
              source: snapshot.source,
              category: snapshot.category,
              kind: snapshot.kind,
              sourcePath: snapshot.sourcePath,
              mime: snapshot.mime,
              tags: snapshot.tags,
              summary: snapshot.summary,
            })
            .then(() => this.load({ silent: true })),
      },
    });
  }

  async importOneDrive(): Promise<ImportReport | null> {
    this.importing = true;
    try {
      const report = await api.notesImport(null);
      await this.load({ silent: true });
      const parts = [`${report.added} new`];
      if (report.updated) parts.push(`${report.updated} updated`);
      toasts.show(`Imported ${parts.join(", ")}`, { kind: "success", timeout: 5000 });
      return report;
    } catch (e) {
      toasts.error(errMsg(e));
      return null;
    } finally {
      this.importing = false;
    }
  }
}

export const notes = new NotesState();
