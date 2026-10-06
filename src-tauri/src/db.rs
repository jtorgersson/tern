//! Local cache: SQLite (WAL) with an FTS5 index over messages.
use crate::model::*;
use anyhow::Result;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  hue INTEGER NOT NULL DEFAULT 210,
  tenant_id TEXT,
  last_sync TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  status_message TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  well_known TEXT,
  parent_id TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS folders_account ON folders(account_id);

CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  preview TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  importance TEXT NOT NULL DEFAULT 'normal',
  web_link TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_account_date ON messages(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(account_id, conversation_id);
CREATE INDEX IF NOT EXISTS messages_flagged ON messages(is_flagged) WHERE is_flagged = 1;

CREATE TABLE IF NOT EXISTS bodies (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS annotations (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  priority INTEGER NOT NULL,
  summary TEXT NOT NULL,
  action_items_json TEXT NOT NULL DEFAULT '[]',
  needs_reply INTEGER NOT NULL DEFAULT 0,
  due_at TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  delta_link TEXT,
  PRIMARY KEY (account_id, folder_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, sender, preview, body,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
"#;

const SUMMARY_COLS: &str = "m.id, m.account_id, m.folder_id, m.conversation_id, m.subject, m.from_name, m.from_email, \
  m.to_json, m.preview, m.received_at, m.is_read, m.is_flagged, m.has_attachments, m.importance, \
  a.category, a.priority, a.summary, a.action_items_json, a.needs_reply, a.due_at";

fn summary_from_row(r: &Row) -> rusqlite::Result<MessageSummary> {
    let id: String = r.get(0)?;
    let category: Option<String> = r.get(14)?;
    let ai = match category {
        Some(category) => Some(Annotation {
            message_id: id.clone(),
            category,
            priority: r.get(15)?,
            summary: r.get(16)?,
            action_items: serde_json::from_str(&r.get::<_, String>(17)?).unwrap_or_default(),
            needs_reply: r.get::<_, i64>(18)? != 0,
            due_at: r.get(19)?,
        }),
        None => None,
    };
    Ok(MessageSummary {
        id,
        account_id: r.get(1)?,
        folder_id: r.get(2)?,
        conversation_id: r.get(3)?,
        subject: r.get(4)?,
        from: Addr { name: r.get(5)?, email: r.get(6)? },
        to: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
        preview: r.get(8)?,
        received_at: r.get(9)?,
        is_read: r.get::<_, i64>(10)? != 0,
        is_flagged: r.get::<_, i64>(11)? != 0,
        has_attachments: r.get::<_, i64>(12)? != 0,
        importance: r.get(13)?,
        ai,
    })
}

fn account_from_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        provider: r.get(1)?,
        email: r.get(2)?,
        display_name: r.get(3)?,
        hue: r.get(4)?,
        tenant_id: r.get(5)?,
        last_sync: r.get(6)?,
        status: r.get(7)?,
        status_message: r.get(8)?,
    })
}

/// A message as received from a provider, ready to upsert.
pub struct IncomingMessage {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub conversation_id: String,
    pub subject: String,
    pub from: Addr,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub preview: String,
    pub received_at: String,
    pub is_read: bool,
    pub is_flagged: bool,
    pub has_attachments: bool,
    pub importance: String,
    pub web_link: Option<String>,
    pub is_draft: bool,
}

pub struct StoredBody {
    pub html: String,
    pub text: String,
    pub bcc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    pub attachments: Vec<Attachment>,
}

/// Turns free text into a safe FTS5 prefix query: `"foo"* "bar"*`.
fn fts_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(" ")
}

impl Db {
    pub fn path() -> PathBuf {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("tern").join("tern.db")
    }

    pub fn open() -> Result<Db> {
        let p = Self::path();
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(p)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- accounts ----------
    pub fn accounts(&self) -> Result<Vec<Account>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT id, provider, email, display_name, hue, tenant_id, last_sync, status, status_message
             FROM accounts ORDER BY sort, created_at",
        )?;
        let rows = st.query_map([], account_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn account(&self, id: &str) -> Result<Option<Account>> {
        let c = self.conn();
        Ok(c.query_row(
            "SELECT id, provider, email, display_name, hue, tenant_id, last_sync, status, status_message
             FROM accounts WHERE id = ?",
            [id],
            account_from_row,
        )
        .optional()?)
    }

    pub fn upsert_account(&self, a: &Account) -> Result<()> {
        let c = self.conn();
        let sort: i64 = c.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM accounts", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO accounts (id, provider, email, display_name, hue, tenant_id, status, sort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', ?7)
             ON CONFLICT(id) DO UPDATE SET email = excluded.email, tenant_id = excluded.tenant_id,
               status = 'ok', status_message = NULL",
            params![a.id, a.provider, a.email, a.display_name, a.hue, a.tenant_id, sort],
        )?;
        Ok(())
    }

    pub fn update_account(&self, id: &str, display_name: Option<&str>, hue: Option<i64>) -> Result<()> {
        let c = self.conn();
        if let Some(n) = display_name {
            c.execute("UPDATE accounts SET display_name = ? WHERE id = ?", params![n, id])?;
        }
        if let Some(h) = hue {
            c.execute("UPDATE accounts SET hue = ? WHERE id = ?", params![h, id])?;
        }
        Ok(())
    }

    pub fn set_account_status(&self, id: &str, status: &str, message: Option<&str>, synced: bool) -> Result<()> {
        let c = self.conn();
        if synced {
            c.execute(
                "UPDATE accounts SET status = ?, status_message = ?, last_sync = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
                params![status, message, id],
            )?;
        } else {
            c.execute("UPDATE accounts SET status = ?, status_message = ? WHERE id = ?", params![status, message, id])?;
        }
        Ok(())
    }

    pub fn remove_account(&self, id: &str) -> Result<()> {
        let c = self.conn();
        c.execute(
            "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ?)",
            [id],
        )?;
        c.execute("DELETE FROM accounts WHERE id = ?", [id])?;
        Ok(())
    }

    // ---------- folders ----------
    pub fn folders(&self, account_id: Option<&str>) -> Result<Vec<Folder>> {
        let c = self.conn();
        let sql = "SELECT id, account_id, name, well_known, parent_id, unread, total FROM folders
                   WHERE (?1 IS NULL OR account_id = ?1)
                   ORDER BY account_id,
                     CASE well_known WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sentitems' THEN 2
                       WHEN 'archive' THEN 3 WHEN 'junkemail' THEN 5 WHEN 'deleteditems' THEN 6 ELSE 4 END,
                     name COLLATE NOCASE";
        let mut st = c.prepare(sql)?;
        let rows = st
            .query_map([account_id], |r| {
                Ok(Folder {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    name: r.get(2)?,
                    well_known: r.get(3)?,
                    parent_id: r.get(4)?,
                    unread: r.get(5)?,
                    total: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn replace_folders(&self, account_id: &str, folders: &[Folder]) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        {
            let mut up = tx.prepare(
                "INSERT INTO folders (id, account_id, name, well_known, parent_id, unread, total)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, well_known = excluded.well_known,
                   parent_id = excluded.parent_id, unread = excluded.unread, total = excluded.total",
            )?;
            for f in folders {
                up.execute(params![f.id, account_id, f.name, f.well_known, f.parent_id, f.unread, f.total])?;
            }
            let keep: Vec<&str> = folders.iter().map(|f| f.id.as_str()).collect();
            let existing: Vec<String> = tx
                .prepare("SELECT id FROM folders WHERE account_id = ?")?
                .query_map([account_id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for id in existing.iter().filter(|id| !keep.contains(&id.as_str())) {
                tx.execute(
                    "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE folder_id = ?)",
                    [id],
                )?;
                tx.execute("DELETE FROM messages WHERE folder_id = ?", [id])?;
                tx.execute("DELETE FROM sync_state WHERE folder_id = ?", [id])?;
                tx.execute("DELETE FROM folders WHERE id = ?", [id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn folder_by_well_known(&self, account_id: &str, wk: &str) -> Result<Option<String>> {
        let c = self.conn();
        Ok(c.query_row(
            "SELECT id FROM folders WHERE account_id = ? AND well_known = ?",
            params![account_id, wk],
            |r| r.get(0),
        )
        .optional()?)
    }

    pub fn folder_well_known(&self, folder_id: &str) -> Result<Option<String>> {
        let c = self.conn();
        Ok(c.query_row("SELECT well_known FROM folders WHERE id = ?", [folder_id], |r| r.get(0)).optional()?.flatten())
    }

    // ---------- sync state ----------
    pub fn delta_link(&self, account_id: &str, folder_id: &str) -> Result<Option<String>> {
        let c = self.conn();
        Ok(c.query_row(
            "SELECT delta_link FROM sync_state WHERE account_id = ? AND folder_id = ?",
            params![account_id, folder_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
    }

    pub fn set_delta_link(&self, account_id: &str, folder_id: &str, link: Option<&str>) -> Result<()> {
        let c = self.conn();
        c.execute(
            "INSERT INTO sync_state (account_id, folder_id, delta_link) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id, folder_id) DO UPDATE SET delta_link = excluded.delta_link",
            params![account_id, folder_id, link],
        )?;
        Ok(())
    }

    // ---------- messages ----------
    /// Upserts messages; returns ids that were not previously known.
    pub fn upsert_messages(&self, msgs: &[IncomingMessage]) -> Result<Vec<String>> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        let mut new_ids = Vec::new();
        {
            let mut exists = tx.prepare("SELECT rowid FROM messages WHERE id = ?")?;
            let mut ins = tx.prepare(
                "INSERT INTO messages (id, account_id, folder_id, conversation_id, subject, from_name, from_email,
                   to_json, cc_json, preview, received_at, is_read, is_flagged, has_attachments, importance, web_link, is_draft)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
                 ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id, conversation_id=excluded.conversation_id,
                   subject=excluded.subject, from_name=excluded.from_name, from_email=excluded.from_email,
                   to_json=excluded.to_json, cc_json=excluded.cc_json, preview=excluded.preview,
                   received_at=excluded.received_at, is_read=excluded.is_read, is_flagged=excluded.is_flagged,
                   has_attachments=excluded.has_attachments, importance=excluded.importance,
                   web_link=excluded.web_link, is_draft=excluded.is_draft",
            )?;
            let mut fts_del = tx.prepare("DELETE FROM messages_fts WHERE rowid = ?")?;
            let mut fts_ins = tx.prepare(
                "INSERT INTO messages_fts (rowid, subject, sender, preview, body)
                 VALUES (?1, ?2, ?3, ?4, COALESCE((SELECT text FROM bodies WHERE message_id = ?5), ''))",
            )?;
            let mut contact = tx.prepare(
                "INSERT INTO contacts (email, name, count, last_seen) VALUES (lower(?1), ?2, 1, ?3)
                 ON CONFLICT(email) DO UPDATE SET count = count + 1,
                   name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
                   last_seen = MAX(COALESCE(last_seen, ''), excluded.last_seen)",
            )?;
            for m in msgs {
                let prev: Option<i64> = exists.query_row([&m.id], |r| r.get(0)).optional()?;
                ins.execute(params![
                    m.id,
                    m.account_id,
                    m.folder_id,
                    m.conversation_id,
                    m.subject,
                    m.from.name,
                    m.from.email,
                    serde_json::to_string(&m.to)?,
                    serde_json::to_string(&m.cc)?,
                    m.preview,
                    m.received_at,
                    m.is_read as i64,
                    m.is_flagged as i64,
                    m.has_attachments as i64,
                    m.importance,
                    m.web_link,
                    m.is_draft as i64,
                ])?;
                let rowid: i64 = tx.query_row("SELECT rowid FROM messages WHERE id = ?", [&m.id], |r| r.get(0))?;
                fts_del.execute([rowid])?;
                let sender = format!("{} {}", m.from.name, m.from.email);
                fts_ins.execute(params![rowid, m.subject, sender, m.preview, m.id])?;
                if prev.is_none() {
                    new_ids.push(m.id.clone());
                    if !m.from.email.is_empty() {
                        contact.execute(params![m.from.email, m.from.name, m.received_at])?;
                    }
                    for a in m.to.iter().chain(m.cc.iter()).filter(|a| !a.email.is_empty()) {
                        contact.execute(params![a.email, a.name, m.received_at])?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(new_ids)
    }

    /// Removes a message, but only if it still lives in `folder_id` (moves arrive as remove+add).
    pub fn remove_message_from_folder(&self, id: &str, folder_id: &str) -> Result<()> {
        let c = self.conn();
        c.execute(
            "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id = ?1 AND folder_id = ?2)",
            params![id, folder_id],
        )?;
        c.execute("DELETE FROM messages WHERE id = ?1 AND folder_id = ?2", params![id, folder_id])?;
        Ok(())
    }

    pub fn delete_messages(&self, ids: &[String]) -> Result<()> {
        let c = self.conn();
        for id in ids {
            c.execute("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id = ?)", [id])?;
            c.execute("DELETE FROM messages WHERE id = ?", [id])?;
        }
        Ok(())
    }

    pub fn set_read(&self, ids: &[String], read: bool) -> Result<()> {
        let c = self.conn();
        for id in ids {
            let changed = c.execute(
                "UPDATE messages SET is_read = ?1 WHERE id = ?2 AND is_read <> ?1",
                params![read as i64, id],
            )?;
            if changed > 0 {
                c.execute(
                    "UPDATE folders SET unread = MAX(0, unread + ?1) WHERE id = (SELECT folder_id FROM messages WHERE id = ?2)",
                    params![if read { -1 } else { 1 }, id],
                )?;
            }
        }
        Ok(())
    }

    pub fn set_flag(&self, ids: &[String], flagged: bool) -> Result<()> {
        let c = self.conn();
        for id in ids {
            c.execute("UPDATE messages SET is_flagged = ? WHERE id = ?", params![flagged as i64, id])?;
        }
        Ok(())
    }

    pub fn set_folder(&self, id: &str, folder_id: &str) -> Result<()> {
        let c = self.conn();
        c.execute("UPDATE messages SET folder_id = ? WHERE id = ?", params![folder_id, id])?;
        Ok(())
    }

    pub fn message_meta(&self, id: &str) -> Result<Option<(String, String, bool)>> {
        let c = self.conn();
        Ok(c.query_row(
            "SELECT account_id, folder_id, is_read FROM messages WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .optional()?)
    }

    pub fn summary(&self, id: &str) -> Result<Option<MessageSummary>> {
        let c = self.conn();
        let sql = format!("SELECT {SUMMARY_COLS} FROM messages m LEFT JOIN annotations a ON a.message_id = m.id WHERE m.id = ?");
        Ok(c.query_row(&sql, [id], summary_from_row).optional()?)
    }

    pub fn cc_of(&self, id: &str) -> Result<Vec<Addr>> {
        let c = self.conn();
        let s: String = c.query_row("SELECT cc_json FROM messages WHERE id = ?", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&s).unwrap_or_default())
    }

    pub fn web_link(&self, id: &str) -> Result<Option<String>> {
        let c = self.conn();
        Ok(c.query_row("SELECT web_link FROM messages WHERE id = ?", [id], |r| r.get(0)).optional()?.flatten())
    }

    pub fn list(&self, q: &MessageQuery) -> Result<Vec<MessageSummary>> {
        let c = self.conn();
        let mut sql = format!("SELECT {SUMMARY_COLS} FROM messages m LEFT JOIN annotations a ON a.message_id = m.id ");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let mut wh: Vec<String> = vec!["m.is_draft = 0 OR m.folder_id IN (SELECT id FROM folders WHERE well_known = 'drafts')".into()];
        match &q.view {
            MessageView::Folder { folder_id } => {
                wh.push("m.folder_id = ?".into());
                args.push(folder_id.clone().into());
            }
            MessageView::Unified { well_known } => {
                wh.push("m.folder_id IN (SELECT id FROM folders WHERE well_known = ?)".into());
                args.push(well_known.clone().into());
            }
            MessageView::Flagged => {
                wh.push("m.is_flagged = 1 AND m.folder_id NOT IN (SELECT id FROM folders WHERE well_known IN ('deleteditems','junkemail'))".into());
            }
            MessageView::Category { category } => {
                wh.push("a.category = ? AND m.folder_id IN (SELECT id FROM folders WHERE well_known = 'inbox')".into());
                args.push(category.clone().into());
            }
            MessageView::Search { query } => {
                let fq = fts_query(query);
                if fq.is_empty() {
                    return Ok(vec![]);
                }
                wh.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".into());
                args.push(fq.into());
            }
        }
        if let Some(acc) = &q.account_id {
            wh.push("m.account_id = ?".into());
            args.push(acc.clone().into());
        }
        if q.unread_only {
            wh.push("m.is_read = 0".into());
        }
        if let Some(b) = &q.before {
            wh.push("m.received_at < ?".into());
            args.push(b.clone().into());
        }
        sql.push_str("WHERE ");
        sql.push_str(&wh.iter().map(|w| format!("({w})")).collect::<Vec<_>>().join(" AND "));
        sql.push_str(" ORDER BY m.received_at DESC LIMIT ?");
        args.push(q.limit.clamp(1, 500).into());
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(args), summary_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn conversation_ids(&self, id: &str) -> Result<Vec<String>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT m2.id FROM messages m1 JOIN messages m2
               ON m2.account_id = m1.account_id AND m2.conversation_id = m1.conversation_id AND m1.conversation_id <> ''
             WHERE m1.id = ?
               AND m2.folder_id NOT IN (SELECT id FROM folders WHERE well_known IN ('deleteditems','junkemail'))
             ORDER BY m2.received_at ASC LIMIT 50",
        )?;
        let mut ids: Vec<String> = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        if ids.is_empty() {
            ids.push(id.to_string());
        }
        Ok(ids)
    }

    pub fn untriaged(&self, limit: i64) -> Result<Vec<MessageSummary>> {
        let c = self.conn();
        let sql = format!(
            "SELECT {SUMMARY_COLS} FROM messages m LEFT JOIN annotations a ON a.message_id = m.id
             WHERE a.message_id IS NULL
               AND m.folder_id IN (SELECT id FROM folders WHERE well_known = 'inbox')
               AND m.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-21 days')
             ORDER BY m.received_at DESC LIMIT ?"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map([limit.clamp(1, 200)], summary_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn set_annotations(&self, items: &[Annotation]) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare(
                "INSERT INTO annotations (message_id, category, priority, summary, action_items_json, needs_reply, due_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?1)
                 ON CONFLICT(message_id) DO UPDATE SET category=excluded.category, priority=excluded.priority,
                   summary=excluded.summary, action_items_json=excluded.action_items_json,
                   needs_reply=excluded.needs_reply, due_at=excluded.due_at",
            )?;
            for a in items {
                st.execute(params![
                    a.message_id,
                    a.category,
                    a.priority.clamp(1, 3),
                    a.summary,
                    serde_json::to_string(&a.action_items)?,
                    a.needs_reply as i64,
                    a.due_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---------- bodies ----------
    pub fn body(&self, id: &str) -> Result<Option<StoredBody>> {
        let c = self.conn();
        Ok(c.query_row(
            "SELECT html, text, bcc_json, reply_to_json, attachments_json FROM bodies WHERE message_id = ?",
            [id],
            |r| {
                Ok(StoredBody {
                    html: r.get(0)?,
                    text: r.get(1)?,
                    bcc: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
                    reply_to: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                    attachments: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                })
            },
        )
        .optional()?)
    }

    pub fn set_body(&self, id: &str, b: &StoredBody) -> Result<()> {
        let c = self.conn();
        c.execute(
            "INSERT OR REPLACE INTO bodies (message_id, html, text, bcc_json, reply_to_json, attachments_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                b.html,
                b.text,
                serde_json::to_string(&b.bcc)?,
                serde_json::to_string(&b.reply_to)?,
                serde_json::to_string(&b.attachments)?
            ],
        )?;
        // Re-index with body text for full-text search.
        let row: Option<(i64, String, String, String, String)> = c
            .query_row(
                "SELECT rowid, subject, from_name || ' ' || from_email, preview, id FROM messages WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        if let Some((rowid, subject, sender, preview, _)) = row {
            c.execute("DELETE FROM messages_fts WHERE rowid = ?", [rowid])?;
            c.execute(
                "INSERT INTO messages_fts (rowid, subject, sender, preview, body) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![rowid, subject, sender, preview, b.text],
            )?;
        }
        Ok(())
    }

    // ---------- contacts ----------
    pub fn contacts(&self, prefix: &str, limit: i64) -> Result<Vec<Contact>> {
        let c = self.conn();
        let like = format!("{}%", prefix.to_lowercase().replace('%', "").replace('_', ""));
        let word = format!("% {}%", prefix.to_lowercase().replace('%', "").replace('_', ""));
        let mut st = c.prepare(
            "SELECT email, name, count FROM contacts
             WHERE email LIKE ?1 OR lower(name) LIKE ?1 OR lower(name) LIKE ?2
             ORDER BY count DESC, last_seen DESC LIMIT ?3",
        )?;
        let rows = st
            .query_map(params![like, word, limit.clamp(1, 50)], |r| {
                Ok(Contact { email: r.get(0)?, name: r.get(1)?, count: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        Db(Arc::new(Mutex::new(conn)))
    }

    fn msg(id: &str, folder: &str, subject: &str, at: &str) -> IncomingMessage {
        IncomingMessage {
            id: id.into(),
            account_id: "a1".into(),
            folder_id: folder.into(),
            conversation_id: "c1".into(),
            subject: subject.into(),
            from: Addr { name: "Åsa Lindström".into(), email: "asa@example.se".into() },
            to: vec![Addr { name: "John".into(), email: "john@emcap.se".into() }],
            cc: vec![],
            preview: "Hej! Kvartalsrapporten är klar".into(),
            received_at: at.into(),
            is_read: false,
            is_flagged: false,
            has_attachments: false,
            importance: "normal".into(),
            web_link: None,
            is_draft: false,
        }
    }

    fn seed(db: &Db) {
        db.upsert_account(&Account {
            id: "a1".into(),
            provider: "microsoft".into(),
            email: "john@emcap.se".into(),
            display_name: "John".into(),
            hue: 40,
            tenant_id: None,
            last_sync: None,
            status: "ok".into(),
            status_message: None,
        })
        .unwrap();
        let f = |id: &str, wk: Option<&str>| Folder {
            id: id.into(),
            account_id: "a1".into(),
            name: id.into(),
            well_known: wk.map(String::from),
            parent_id: None,
            unread: 2,
            total: 2,
        };
        db.replace_folders("a1", &[f("inbox", Some("inbox")), f("arch", Some("archive")), f("del", Some("deleteditems"))])
            .unwrap();
    }

    #[test]
    fn upsert_list_search_and_moves() {
        let db = mem();
        seed(&db);
        let new = db
            .upsert_messages(&[
                msg("m1", "inbox", "Quarterly report", "2026-10-05T10:00:00Z"),
                msg("m2", "inbox", "Lunch?", "2026-10-06T09:00:00Z"),
            ])
            .unwrap();
        assert_eq!(new, vec!["m1", "m2"]);
        // second upsert is not "new"
        assert!(db.upsert_messages(&[msg("m1", "inbox", "Quarterly report v2", "2026-10-05T10:00:00Z")]).unwrap().is_empty());

        let q = |view| MessageQuery { view, account_id: None, unread_only: false, limit: 50, before: None };
        let inbox = db.list(&q(MessageView::Unified { well_known: "inbox".into() })).unwrap();
        assert_eq!(inbox.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["m2", "m1"]);

        // FTS: prefix, diacritics-insensitive sender, updated subject
        let s = db.list(&q(MessageView::Search { query: "quart v2".into() })).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(db.list(&q(MessageView::Search { query: "lindstrom".into() })).unwrap().len(), 2);

        // body indexing
        db.set_body("m2", &StoredBody { html: "<p>pizza</p>".into(), text: "pizza at noon".into(), bcc: vec![], reply_to: vec![], attachments: vec![] })
            .unwrap();
        assert_eq!(db.list(&q(MessageView::Search { query: "pizza".into() })).unwrap()[0].id, "m2");

        // read counters
        db.set_read(&["m1".into()], true).unwrap();
        let inbox_f = db.folders(Some("a1")).unwrap().into_iter().find(|f| f.id == "inbox").unwrap();
        assert_eq!(inbox_f.unread, 1);

        // move: arrives as remove-from-old + add-to-new, in either order
        db.upsert_messages(&[msg("m1", "arch", "Quarterly report v2", "2026-10-05T10:00:00Z")]).unwrap();
        db.remove_message_from_folder("m1", "inbox").unwrap(); // stale removal must not delete it
        assert_eq!(db.list(&q(MessageView::Folder { folder_id: "arch".into() })).unwrap().len(), 1);

        // annotations + category view
        db.set_annotations(&[Annotation {
            message_id: "m2".into(),
            category: "needs_reply".into(),
            priority: 3,
            summary: "Lunch invite".into(),
            action_items: vec!["Reply".into()],
            needs_reply: true,
            due_at: None,
        }])
        .unwrap();
        let cat = db.list(&q(MessageView::Category { category: "needs_reply".into() })).unwrap();
        assert_eq!(cat.len(), 1);
        assert!(cat[0].ai.as_ref().unwrap().needs_reply);
        assert_eq!(db.untriaged(10).unwrap().len(), 0);

        // contacts
        let c = db.contacts("as", 5).unwrap();
        assert_eq!(c[0].email, "asa@example.se");
        assert_eq!(db.contacts("lind", 5).unwrap().len(), 1);

        // thread
        assert_eq!(db.conversation_ids("m2").unwrap().len(), 2);

        // delete keeps FTS consistent
        db.delete_messages(&["m2".into()]).unwrap();
        assert!(db.list(&q(MessageView::Search { query: "pizza".into() })).unwrap().is_empty());

        // removing the account cascades
        db.remove_account("a1").unwrap();
        assert!(db.list(&q(MessageView::Search { query: "quart".into() })).unwrap().is_empty());
    }
}
