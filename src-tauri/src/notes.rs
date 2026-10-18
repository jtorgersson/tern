//! Local notes: quick capture, OneDrive import, and full-text search.
use crate::db::Db;
use crate::state::AppState;
use anyhow::{bail, Context, Result};
use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

const PAGE_MAX: i64 = 80;
const IMPORT_CAP: usize = 4000;
const CANDIDATE_CAP: usize = 20_000;
const TEXT_MAX: u64 = 512 * 1024;
const BODY_MAX: usize = 80_000;
const IMAGE_MAX: u64 = 40 * 1024 * 1024;
const VISION_MAX: u64 = 1_200_000;

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "obj", "bin", "target", "dist", ".vs", "packages", "vendor",
    "__pycache__", ".next", ".cache", "debug", "release", "out", "build", ".idea", "venv",
    ".venv", ".svn", "coverage",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub body: String,
    pub kind: String,
    pub category: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub source: String,
    pub source_path: Option<String>,
    pub mime: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub edited: bool,
    pub created_at: String,
    pub updated_at: String,
    pub analyzed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFacet {
    pub category: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePage {
    pub notes: Vec<Note>,
    pub total: i64,
    pub archived: i64,
    pub unanalyzed: i64,
    pub facets: Vec<NoteFacet>,
    pub revision: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoteQuery {
    pub q: Option<String>,
    pub category: Option<String>,
    pub kind: Option<String>,
    pub archived: Option<bool>,
    pub unanalyzed: Option<bool>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreate {
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdate {
    pub id: String,
    pub title: String,
    pub body: String,
    pub category: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAnalysis {
    pub id: String,
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: i64,
    pub updated: i64,
    pub skipped: i64,
    pub scanned: i64,
    pub truncated: bool,
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteImage {
    pub media_type: String,
    pub base64: String,
}

pub enum NoteCli {
    None,
    Capture,
    Text(String),
}

pub fn parse_note_cli(args: &[String]) -> NoteCli {
    let Some(first) = args.first() else { return NoteCli::None };
    if first != "note" && first != "--note" {
        return NoteCli::None;
    }
    let text = args[1..].join(" ").trim().to_string();
    if text.is_empty() { NoteCli::Capture } else { NoteCli::Text(text) }
}

fn library_root(st: &AppState) -> PathBuf {
    crate::settings::notes_folder(&st.settings.read().unwrap())
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn tags_of(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for tag in tags {
        let t = tag.trim().trim_matches('#').to_string();
        if t.is_empty() || t.chars().count() > 32 || out.iter().any(|e: &String| e.eq_ignore_ascii_case(&t)) {
            continue;
        }
        out.push(t);
        if out.len() == 6 {
            break;
        }
    }
    out
}

fn split_capture(text: &str) -> (String, String) {
    let text = text.trim();
    if text.is_empty() {
        return ("Untitled".into(), String::new());
    }
    let mut lines = text.lines();
    let first = lines.next().unwrap_or("").trim().trim_start_matches('#').trim();
    let rest = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    let short = first.chars().count() <= 90;
    if short && !rest.is_empty() {
        (first.to_string(), rest)
    } else if short {
        (first.to_string(), String::new())
    } else {
        (first.chars().take(90).collect(), text.to_string())
    }
}

fn fts_query(q: &str) -> String {
    q.split_whitespace()
        .filter_map(|word| {
            let clean: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
            if clean.is_empty() { None } else { Some(format!("\"{clean}\"*")) }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn row_note(r: &rusqlite::Row, with_body: bool) -> rusqlite::Result<Note> {
    let body: String = if with_body { r.get(3)? } else { String::new() };
    let excerpt: String = r.get(2)?;
    let tags: String = r.get(6)?;
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        excerpt: if excerpt.is_empty() { excerpt.clone() } else { excerpt },
        body,
        kind: r.get(4)?,
        category: r.get(5)?,
        tags: tags_of(&tags),
        summary: r.get(7)?,
        source: r.get(8)?,
        source_path: r.get(9)?,
        mime: r.get(10)?,
        pinned: r.get::<_, i64>(11)? != 0,
        archived: r.get::<_, i64>(12)? != 0,
        edited: r.get::<_, i64>(13)? != 0,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        analyzed_at: r.get(16)?,
    })
}

const LIST_COLS: &str = "id, title, substr(replace(replace(body, char(10), ' '), char(13), ' '), 1, 240), '' AS body, \
    kind, category, tags_json, summary, source, source_path, mime, pinned, archived, edited, created_at, updated_at, analyzed_at";

const FULL_COLS: &str = "id, title, substr(replace(replace(body, char(10), ' '), char(13), ' '), 1, 240), body, \
    kind, category, tags_json, summary, source, source_path, mime, pinned, archived, edited, created_at, updated_at, analyzed_at";

fn index_note(c: &rusqlite::Connection, rowid: i64, title: &str, body: &str, summary: &str, tags: &[String]) -> Result<()> {
    c.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])?;
    c.execute(
        "INSERT INTO notes_fts (rowid, title, body, summary, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![rowid, title, body, summary, tags.join(" ")],
    )?;
    Ok(())
}

fn page(db: &Db, query: &NoteQuery) -> Result<NotePage> {
    let c = db.conn();
    let archived = query.archived.unwrap_or(false);
    let mut wh = vec!["archived = ?1".to_string()];
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(archived as i64)];
    if let Some(cat) = query.category.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        wh.push(format!("category = ?{}", args.len() + 1));
        args.push(Box::new(cat.to_string()));
    }
    if let Some(kind) = query.kind.as_ref().map(|s| s.trim()).filter(|s| *s == "text" || *s == "image") {
        wh.push(format!("kind = ?{}", args.len() + 1));
        args.push(Box::new(kind.to_string()));
    }
    if query.unanalyzed.unwrap_or(false) {
        wh.push("analyzed_at IS NULL".into());
    }
    if let Some(q) = query.q.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let fts = fts_query(q);
        if fts.is_empty() {
            wh.push("0".into());
        } else {
            wh.push(format!("rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?{})", args.len() + 1));
            args.push(Box::new(fts));
        }
    }
    let where_sql = wh.join(" AND ");
    let order = match query.sort.as_deref() {
        Some("title") => "pinned DESC, title COLLATE NOCASE ASC",
        Some("created") => "pinned DESC, created_at DESC",
        _ => "pinned DESC, updated_at DESC",
    };
    let limit = query.limit.unwrap_or(48).clamp(1, PAGE_MAX);
    let offset = query.offset.unwrap_or(0).max(0);
    let total: i64 = c.query_row(&format!("SELECT COUNT(*) FROM notes WHERE {where_sql}"), rusqlite::params_from_iter(args.iter()), |r| r.get(0))?;
    let mut st = c.prepare(&format!("SELECT {LIST_COLS} FROM notes WHERE {where_sql} ORDER BY {order} LIMIT ?{} OFFSET ?{}", args.len() + 1, args.len() + 2))?;
    let mut with_page = args;
    with_page.push(Box::new(limit));
    with_page.push(Box::new(offset));
    let notes = st
        .query_map(rusqlite::params_from_iter(with_page.iter()), |r| row_note(r, false))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let facets = c
        .prepare("SELECT category, COUNT(*) FROM notes WHERE archived = 0 GROUP BY category ORDER BY COUNT(*) DESC, category COLLATE NOCASE")?
        .query_map([], |r| Ok(NoteFacet { category: r.get(0)?, count: r.get(1)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let archived_n: i64 = c.query_row("SELECT COUNT(*) FROM notes WHERE archived = 1", [], |r| r.get(0))?;
    let unanalyzed: i64 = c.query_row("SELECT COUNT(*) FROM notes WHERE archived = 0 AND analyzed_at IS NULL", [], |r| r.get(0))?;
    let revision: String = c.query_row(
        "SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') FROM notes",
        [],
        |r| r.get(0),
    )?;
    Ok(NotePage { notes, total, archived: archived_n, unanalyzed, facets, revision })
}

fn get_note(db: &Db, id: &str) -> Result<Note> {
    let c = db.conn();
    c.query_row(&format!("SELECT {FULL_COLS} FROM notes WHERE id = ?1"), [id], |r| row_note(r, true))
        .optional()?
        .context("Note not found")
}

fn insert_note(
    db: &Db,
    title: &str,
    body: &str,
    kind: &str,
    category: &str,
    source: &str,
    source_path: Option<&str>,
    mime: Option<&str>,
    file_mtime: Option<i64>,
    edited: bool,
) -> Result<Note> {
    let c = db.conn();
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let title = if title.trim().is_empty() { "Untitled" } else { title.trim() };
    let category = if category.trim().is_empty() { "Inbox" } else { category.trim() };
    c.execute(
        "INSERT INTO notes (id, title, body, kind, category, tags_json, summary, source, source_path, mime, pinned, archived, edited, created_at, updated_at, analyzed_at, file_mtime)
         VALUES (?1, ?2, ?3, ?4, ?5, '[]', '', ?6, ?7, ?8, 0, 0, ?9, ?10, ?10, NULL, ?11)",
        params![id, title, body, kind, category, source, source_path, mime, edited as i64, ts, file_mtime],
    )?;
    let rowid = c.last_insert_rowid();
    index_note(&c, rowid, title, body, "", &[])?;
    drop(c);
    get_note(db, &id)
}

pub fn capture_note_cli(text: &str) -> Result<()> {
    let (title, body) = split_capture(text);
    let db = Db::open()?;
    let note = insert_note(&db, &title, &body, "text", "Inbox", "terminal", None, Some("text/plain"), None, false)?;
    println!("{}", note.title);
    let _ = std::process::Command::new("notify-send")
        .args(["-a", "Tern", "Noted", &note.title])
        .status();
    Ok(())
}

fn path_allowed(path: &Path, root: &Path) -> bool {
    if path.exists() {
        return under_root(path, root);
    }
    path.starts_with(root)
}

fn under_root(path: &Path, root: &Path) -> bool {
    let Ok(path) = path.canonicalize() else { return false };
    let Ok(root) = root.canonicalize() else { return false };
    path.starts_with(root)
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d))
}

fn skip_file(name: &str) -> bool {
    let l = name.to_lowercase();
    l.starts_with('.')
        || l.starts_with("~$")
        || l.contains("filelistabsolute")
        || l.starts_with("publishoutputs")
        || l == "thumbs.db"
        || l == "desktop.ini"
}

fn ext_kind(path: &Path) -> Option<(&'static str, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "md" | "markdown" => ("text", "text/markdown"),
        "txt" | "text" => ("text", "text/plain"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        _ => return None,
    })
}

fn category_for(root: &Path, file: &Path) -> String {
    let Ok(rel) = file.strip_prefix(root) else { return "Inbox".into() };
    let mut comps = rel.components();
    let Some(first) = comps.next() else { return "Inbox".into() };
    if comps.next().is_none() {
        return "Inbox".into();
    }
    let name = first.as_os_str().to_string_lossy().trim().to_string();
    if name.is_empty() { "Inbox".into() } else { name }
}

fn title_of(path: &Path, body: &str, kind: &str) -> String {
    if kind == "text" {
        for line in body.lines() {
            let t = line.trim().trim_start_matches('#').trim();
            if t.is_empty() {
                continue;
            }
            return t.chars().take(100).collect();
        }
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().replace('_', " "))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Untitled".into())
}

struct Candidate {
    path: PathBuf,
    mtime: i64,
    kind: &'static str,
    mime: &'static str,
}

fn collect(root: &Path) -> (Vec<Candidate>, bool) {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        if out.len() >= CANDIDATE_CAP {
            truncated = true;
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let path = ent.path();
            let Ok(ft) = ent.file_type() else { continue };
            if ft.is_dir() {
                if !skip_dir(&name) {
                    stack.push(path);
                }
                continue;
            }
            if !ft.is_file() || skip_file(&name) {
                continue;
            }
            let Some((kind, mime)) = ext_kind(&path) else { continue };
            let Ok(meta) = ent.metadata() else { continue };
            let max = if kind == "image" { IMAGE_MAX } else { TEXT_MAX };
            if meta.len() == 0 || meta.len() > max {
                continue;
            }
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
            out.push(Candidate { path, mtime, kind, mime });
            if out.len() >= CANDIDATE_CAP {
                truncated = true;
                break;
            }
        }
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    if out.len() > IMPORT_CAP {
        out.truncate(IMPORT_CAP);
        truncated = true;
    }
    (out, truncated)
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(BODY_MAX).collect())
}

fn import_root(db: &Db, root: &Path) -> Result<ImportReport> {
    if !root.is_dir() {
        bail!("{} is not a folder", root.display());
    }
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let (cands, truncated) = collect(&root);
    let mut added = 0i64;
    let mut updated = 0i64;
    let mut skipped = 0i64;
    {
        let c = db.conn();
        let tx = c.unchecked_transaction()?;
        for cand in &cands {
            let path_s = cand.path.to_string_lossy().to_string();
            let existing: Option<(i64, i64, Option<i64>)> = tx
                .query_row(
                    "SELECT rowid, edited, file_mtime FROM notes WHERE source_path = ?1",
                    [&path_s],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((rowid, edited, mtime)) = existing {
                if mtime == Some(cand.mtime) || edited != 0 {
                    skipped += 1;
                    continue;
                }
                let body = if cand.kind == "text" { read_text(&cand.path).unwrap_or_default() } else { String::new() };
                if cand.kind == "text" && body.is_empty() {
                    skipped += 1;
                    continue;
                }
                let title = title_of(&cand.path, &body, cand.kind);
                let category = category_for(&root, &cand.path);
                tx.execute(
                    "UPDATE notes SET title = ?2, body = ?3, kind = ?4, category = ?5, mime = ?6, file_mtime = ?7, updated_at = ?8 WHERE rowid = ?1",
                    params![rowid, title, body, cand.kind, category, cand.mime, cand.mtime, now()],
                )?;
                let summary: String = tx.query_row("SELECT summary FROM notes WHERE rowid = ?1", [rowid], |r| r.get(0))?;
                let tags: String = tx.query_row("SELECT tags_json FROM notes WHERE rowid = ?1", [rowid], |r| r.get(0))?;
                index_note(&tx, rowid, &title, &body, &summary, &tags_of(&tags))?;
                updated += 1;
            } else {
                let body = if cand.kind == "text" { read_text(&cand.path).unwrap_or_default() } else { String::new() };
                if cand.kind == "text" && body.is_empty() {
                    skipped += 1;
                    continue;
                }
                let title = title_of(&cand.path, &body, cand.kind);
                let category = category_for(&root, &cand.path);
                let id = Uuid::new_v4().to_string();
                let ts = now();
                tx.execute(
                    "INSERT INTO notes (id, title, body, kind, category, tags_json, summary, source, source_path, mime, pinned, archived, edited, created_at, updated_at, analyzed_at, file_mtime)
                     VALUES (?1, ?2, ?3, ?4, ?5, '[]', '', 'onedrive', ?6, ?7, 0, 0, 0, ?8, ?8, NULL, ?9)",
                    params![id, title, body, cand.kind, category, path_s, cand.mime, ts, cand.mtime],
                )?;
                index_note(&tx, tx.last_insert_rowid(), &title, &body, "", &[])?;
                added += 1;
            }
        }
        tx.commit()?;
    }
    Ok(ImportReport {
        added,
        updated,
        skipped,
        scanned: cands.len() as i64,
        truncated,
        root: root.display().to_string(),
    })
}

pub fn open_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Err(e) = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("/?capture=1".into()))
        .title("Tern Note")
        .inner_size(520.0, 340.0)
        .min_inner_size(420.0, 240.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .center()
        .focused(true)
        .build()
    {
        log::warn!("capture window: {e}");
    }
}

fn note_arg_text(args: &[String]) -> Option<String> {
    let i = args.iter().position(|a| a == "note" || a == "--note")?;
    Some(args.get(i + 1..).map(|r| r.join(" ")).unwrap_or_default())
}

/// Second-instance args: open the capture window, or save text into the running app.
pub fn handle_instance_args(app: &AppHandle, args: &[String]) -> bool {
    let Some(text) = note_arg_text(args) else { return false };
    let text = text.trim().to_string();
    if text.is_empty() {
        open_capture(app);
        return true;
    }
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        let (title, body) = split_capture(&text);
        if insert_note(&st.db, &title, &body, "text", "Inbox", "terminal", None, Some("text/plain"), None, false).is_ok() {
            let _ = app.emit("notes://changed", ());
        }
    }
    true
}

type St<'a> = State<'a, Arc<AppState>>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn notes_list(st: St, query: NoteQuery) -> Result<NotePage, String> {
    page(&st.db, &query).map_err(err)
}

#[tauri::command]
pub fn notes_get(st: St, id: String) -> Result<Note, String> {
    get_note(&st.db, &id).map_err(err)
}

#[tauri::command]
pub fn notes_create(st: St, draft: NoteCreate) -> Result<Note, String> {
    let source = match draft.source.as_deref() {
        Some("terminal") => "terminal",
        Some("onedrive") => "onedrive",
        _ => "capture",
    };
    let (title, body) = match draft.title.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(title) => (title.to_string(), draft.body.trim().to_string()),
        None => split_capture(&draft.body),
    };
    if title == "Untitled" && body.is_empty() {
        return Err("Write something first".into());
    }
    let category = draft.category.unwrap_or_else(|| "Inbox".into());
    let kind = if draft.kind.as_deref() == Some("image") { "image" } else { "text" };
    let root = library_root(&st);
    let source_path = draft.source_path.as_deref().filter(|p| path_allowed(Path::new(p), &root));
    if draft.source_path.as_ref().is_some_and(|p| !p.is_empty()) && source_path.is_none() {
        return Err("That file is outside the notes folder".into());
    }
    let mime = draft.mime.as_deref().or(if kind == "image" { None } else { Some("text/plain") });
    let note = insert_note(&st.db, &title, &body, kind, &category, source, source_path, mime, None, false).map_err(err)?;
    if draft.tags.as_ref().is_some_and(|t| !t.is_empty()) || draft.summary.as_ref().is_some_and(|s| !s.trim().is_empty()) {
        let tags = clean_tags(draft.tags.as_deref().unwrap_or(&[]));
        let summary = draft.summary.unwrap_or_default().trim().chars().take(280).collect::<String>();
        let tags_json = serde_json::to_string(&tags).map_err(err)?;
        let c = st.db.conn();
        let rowid: i64 = c.query_row("SELECT rowid FROM notes WHERE id = ?1", [&note.id], |r| r.get(0)).map_err(err)?;
        c.execute("UPDATE notes SET tags_json = ?2, summary = ?3 WHERE id = ?1", params![note.id, tags_json, summary]).map_err(err)?;
        index_note(&c, rowid, &note.title, &body, &summary, &tags).map_err(err)?;
        drop(c);
        return get_note(&st.db, &note.id).map_err(err);
    }
    Ok(note)
}

#[tauri::command]
pub fn notes_update(st: St, draft: NoteUpdate) -> Result<Note, String> {
    let tags = clean_tags(&draft.tags);
    let tags_json = serde_json::to_string(&tags).map_err(err)?;
    let title = if draft.title.trim().is_empty() { "Untitled".into() } else { draft.title.trim().to_string() };
    let category = if draft.category.trim().is_empty() { "Inbox".into() } else { draft.category.trim().to_string() };
    let body = draft.body.trim().to_string();
    let ts = now();
    {
        let c = st.db.conn();
        let rowid: i64 = c
            .query_row("SELECT rowid FROM notes WHERE id = ?1", [&draft.id], |r| r.get(0))
            .optional()
            .map_err(err)?
            .ok_or_else(|| "Note not found".to_string())?;
        let summary: String = c.query_row("SELECT summary FROM notes WHERE id = ?1", [&draft.id], |r| r.get(0)).map_err(err)?;
        c.execute(
            "UPDATE notes SET title = ?2, body = ?3, category = ?4, tags_json = ?5, edited = 1, updated_at = ?6 WHERE id = ?1",
            params![draft.id, title, body, category, tags_json, ts],
        )
        .map_err(err)?;
        index_note(&c, rowid, &title, &body, &summary, &tags).map_err(err)?;
    }
    get_note(&st.db, &draft.id).map_err(err)
}

#[tauri::command]
pub fn notes_meta(st: St, patch: NoteMeta) -> Result<Note, String> {
    let c = st.db.conn();
    if let Some(pinned) = patch.pinned {
        c.execute("UPDATE notes SET pinned = ?2, updated_at = ?3 WHERE id = ?1", params![patch.id, pinned as i64, now()]).map_err(err)?;
    }
    if let Some(archived) = patch.archived {
        c.execute("UPDATE notes SET archived = ?2, updated_at = ?3 WHERE id = ?1", params![patch.id, archived as i64, now()]).map_err(err)?;
    }
    if let Some(category) = patch.category.as_ref() {
        let category = if category.trim().is_empty() { "Inbox".to_string() } else { category.trim().to_string() };
        c.execute("UPDATE notes SET category = ?2, updated_at = ?3 WHERE id = ?1", params![patch.id, category, now()]).map_err(err)?;
    }
    if let Some(tags) = patch.tags.as_ref() {
        let tags = clean_tags(tags);
        let tags_json = serde_json::to_string(&tags).map_err(err)?;
        let rowid: i64 = c.query_row("SELECT rowid FROM notes WHERE id = ?1", [&patch.id], |r| r.get(0)).map_err(err)?;
        let (title, body, summary): (String, String, String) = c
            .query_row("SELECT title, body, summary FROM notes WHERE id = ?1", [&patch.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?;
        c.execute("UPDATE notes SET tags_json = ?2, updated_at = ?3 WHERE id = ?1", params![patch.id, tags_json, now()]).map_err(err)?;
        index_note(&c, rowid, &title, &body, &summary, &tags).map_err(err)?;
    }
    drop(c);
    get_note(&st.db, &patch.id).map_err(err)
}

#[tauri::command]
pub fn notes_apply(st: St, items: Vec<NoteAnalysis>) -> Result<usize, String> {
    let c = st.db.conn();
    let ts = now();
    let mut n = 0;
    for item in items {
        let tags = clean_tags(&item.tags);
        let tags_json = serde_json::to_string(&tags).map_err(err)?;
        let title = item.title.trim();
        let category = if item.category.trim().is_empty() { "Inbox" } else { item.category.trim() };
        let summary = item.summary.trim().chars().take(280).collect::<String>();
        let changed = c
            .execute(
                "UPDATE notes SET title = CASE WHEN ?2 = '' THEN title ELSE ?2 END, category = ?3, tags_json = ?4, summary = ?5, analyzed_at = ?6, updated_at = ?6 WHERE id = ?1",
                params![item.id, title, category, tags_json, summary, ts],
            )
            .map_err(err)?;
        if changed == 0 {
            continue;
        }
        let rowid: i64 = c.query_row("SELECT rowid FROM notes WHERE id = ?1", [&item.id], |r| r.get(0)).map_err(err)?;
        let (title, body): (String, String) = c
            .query_row("SELECT title, body FROM notes WHERE id = ?1", [&item.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        index_note(&c, rowid, &title, &body, &summary, &tags).map_err(err)?;
        n += 1;
    }
    Ok(n)
}

#[tauri::command]
pub fn notes_delete(st: St, id: String) -> Result<(), String> {
    let c = st.db.conn();
    let rowid: Option<i64> = c.query_row("SELECT rowid FROM notes WHERE id = ?1", [&id], |r| r.get(0)).optional().map_err(err)?;
    let Some(rowid) = rowid else { return Ok(()) };
    c.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid]).map_err(err)?;
    c.execute("DELETE FROM notes WHERE id = ?1", [&id]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn notes_import(st: St, root: Option<String>) -> Result<ImportReport, String> {
    let configured = library_root(&st);
    let notes = match root.filter(|s| !s.trim().is_empty()) {
        Some(raw) => {
            let path = PathBuf::from(raw.trim());
            if path != configured && !path_allowed(&path, &configured) {
                return Err("Set this folder in Settings → Notes, then import again".into());
            }
            configured
        }
        None => configured,
    };
    import_root(&st.db, &notes).map_err(err)
}

#[tauri::command]
pub fn notes_image(st: St, id: String) -> Result<Option<NoteImage>, String> {
    let note = get_note(&st.db, &id).map_err(err)?;
    if note.kind != "image" {
        return Ok(None);
    }
    let Some(path) = note.source_path else { return Ok(None) };
    let path = PathBuf::from(path);
    if !under_root(&path, &library_root(&st)) {
        return Ok(None);
    }
    let mime = note.mime.unwrap_or_default();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return Ok(None);
    }
    let meta = fs::metadata(&path).map_err(err)?;
    if meta.len() == 0 || meta.len() > VISION_MAX {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(err)?;
    Ok(Some(NoteImage {
        media_type: mime,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

#[tauri::command]
pub fn notes_revision(st: St) -> Result<String, String> {
    let c = st.db.conn();
    c.query_row("SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') FROM notes", [], |r| r.get(0))
        .map_err(err)
}

#[tauri::command]
pub fn take_pending_notes(st: St) -> bool {
    std::mem::take(&mut *st.pending_notes.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_search_and_import() {
        let db = Db::memory().unwrap();
        let note = insert_note(&db, "Buy milk", "oat milk from the shop", "text", "Inbox", "capture", None, Some("text/plain"), None, false).unwrap();
        let found = page(&db, &NoteQuery { q: Some("oat".into()), ..NoteQuery::default() }).unwrap();
        assert_eq!(found.notes.len(), 1);
        assert_eq!(found.notes[0].id, note.id);
        assert!(found.notes[0].body.is_empty());
        let full = get_note(&db, &note.id).unwrap();
        assert!(full.body.contains("oat"));

        let dir = std::env::temp_dir().join(format!("tern-notes-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join("Finance")).unwrap();
        fs::create_dir_all(dir.join("obj")).unwrap();
        fs::write(dir.join("Finance/hello.md"), "# Board notes\n\nCall Anna about the invoice.\n").unwrap();
        fs::write(dir.join("loose.txt"), "A note at the root\n").unwrap();
        fs::write(dir.join("obj/FileListAbsolute.txt"), "ignore me\n").unwrap();
        fs::write(dir.join("Finance/receipt.png"), [0x89, 0x50, 0x4E, 0x47]).unwrap();
        let report = import_root(&db, &dir).unwrap();
        assert_eq!(report.added, 3);
        let finance = page(&db, &NoteQuery { category: Some("Finance".into()), ..NoteQuery::default() }).unwrap();
        assert_eq!(finance.total, 2);
        let hello = finance.notes.iter().find(|n| n.kind == "text").unwrap();
        assert_eq!(hello.title, "Board notes");
        let inbox = page(&db, &NoteQuery { category: Some("Inbox".into()), ..NoteQuery::default() }).unwrap();
        assert!(inbox.notes.iter().any(|n| n.title == "A note at the root"));
        let again = import_root(&db, &dir).unwrap();
        assert_eq!(again.added, 0);
        assert!(again.skipped >= 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_parse_splits_title() {
        assert!(matches!(parse_note_cli(&["note".into()]), NoteCli::Capture));
        assert!(matches!(parse_note_cli(&["--mcp".into()]), NoteCli::None));
        let (title, body) = split_capture("Remember the milk\nOat, not cow");
        assert_eq!(title, "Remember the milk");
        assert_eq!(body, "Oat, not cow");
    }
}
