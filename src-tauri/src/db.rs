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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  owner_id TEXT,
  sync_mail INTEGER NOT NULL DEFAULT 1,
  shared_consent INTEGER NOT NULL DEFAULT 0
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
  is_draft INTEGER NOT NULL DEFAULT 0,
  meeting_type TEXT
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
  attachments_json TEXT NOT NULL DEFAULT '[]',
  unsubscribe_json TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  priority INTEGER NOT NULL,
  summary TEXT NOT NULL,
  action_items_json TEXT NOT NULL DEFAULT '[]',
  needs_reply INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  suggested_reply TEXT
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

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  tz TEXT NOT NULL,
  is_all_day INTEGER NOT NULL DEFAULT 0,
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  organizer_json TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  response TEXT NOT NULL DEFAULT 'none',
  show_as TEXT NOT NULL DEFAULT 'busy',
  is_online INTEGER NOT NULL DEFAULT 0,
  join_url TEXT,
  web_link TEXT,
  preview TEXT NOT NULL DEFAULT '',
  series_master_id TEXT,
  response_requested INTEGER NOT NULL DEFAULT 1,
  calendar_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT 'singleInstance',
  reminder_minutes INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  importance TEXT NOT NULL DEFAULT 'normal',
  categories_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS events_acc_start ON events(account_id, start_local);

CREATE TABLE IF NOT EXISTS snoozes (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snoozes_until ON snoozes(until);

CREATE TABLE IF NOT EXISTS event_notes (
  event_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, sender, preview, body,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
"#;

/// Idempotent column additions for databases created by older versions.
fn migrate(conn: &Connection) -> Result<()> {
    let has: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('annotations') WHERE name = 'suggested_reply'")?
        .exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE annotations ADD COLUMN suggested_reply TEXT")?;
    }
    let has: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'meeting_type'")?
        .exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE messages ADD COLUMN meeting_type TEXT")?;
    }
    for (col, ddl) in [
        ("owner_id", "TEXT"),
        ("sync_mail", "INTEGER NOT NULL DEFAULT 1"),
        ("shared_consent", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        let has: bool = conn.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = ?1")?.exists([col])?;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE accounts ADD COLUMN {col} {ddl}"))?;
        }
    }
    let has: bool = conn.prepare("SELECT 1 FROM pragma_table_info('bodies') WHERE name = 'unsubscribe_json'")?.exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE bodies ADD COLUMN unsubscribe_json TEXT")?;
    }
    for (col, ddl) in [
        ("calendar_id", "TEXT NOT NULL DEFAULT ''"),
        ("event_type", "TEXT NOT NULL DEFAULT 'singleInstance'"),
        ("reminder_minutes", "INTEGER"),
        ("sensitivity", "TEXT NOT NULL DEFAULT 'normal'"),
        ("importance", "TEXT NOT NULL DEFAULT 'normal'"),
        ("categories_json", "TEXT NOT NULL DEFAULT '[]'"),
    ] {
        let has: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = ?1")?
            .exists([col])?;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE events ADD COLUMN {col} {ddl}"))?;
        }
    }
    Ok(())
}

const EVENT_COLS: &str = "id, account_id, subject, start_local, end_local, tz, is_all_day, is_cancelled, location, organizer_json, \
  attendees_json, response, show_as, is_online, join_url, web_link, preview, series_master_id, response_requested, \
  calendar_id, event_type, reminder_minutes, sensitivity, importance, categories_json";

fn row_event(r: &Row) -> rusqlite::Result<CalEvent> {
    Ok(CalEvent {
        id: r.get(0)?,
        account_id: r.get(1)?,
        subject: r.get(2)?,
        start: r.get(3)?,
        end: r.get(4)?,
        time_zone: r.get(5)?,
        is_all_day: r.get::<_, i64>(6)? != 0,
        is_cancelled: r.get::<_, i64>(7)? != 0,
        location: r.get(8)?,
        organizer: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
        attendees: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        response: r.get(11)?,
        show_as: r.get(12)?,
        is_online: r.get::<_, i64>(13)? != 0,
        join_url: r.get(14)?,
        web_link: r.get(15)?,
        preview: r.get(16)?,
        series_master_id: r.get(17)?,
        response_requested: r.get::<_, i64>(18)? != 0,
        calendar_id: r.get(19)?,
        event_type: r.get(20)?,
        reminder_minutes: r.get(21)?,
        sensitivity: r.get(22)?,
        importance: r.get(23)?,
        categories: serde_json::from_str(&r.get::<_, String>(24)?).unwrap_or_default(),
    })
}

const SUMMARY_COLS: &str = "m.id, m.account_id, m.folder_id, m.conversation_id, m.subject, m.from_name, m.from_email, \
  m.to_json, m.preview, m.received_at, m.is_read, m.is_flagged, m.has_attachments, m.importance, \
  a.category, a.priority, a.summary, a.action_items_json, a.needs_reply, a.due_at, a.suggested_reply, m.meeting_type, \
  (SELECT until FROM snoozes s WHERE s.message_id = m.id)";

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
            suggested_reply: r.get(20)?,
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
        meeting_type: r.get(21)?,
        ai,
        snoozed_until: r.get(22)?,
    })
}

const ACCOUNT_COLS: &str =
    "id, provider, email, display_name, hue, tenant_id, last_sync, status, status_message, owner_id, sync_mail, shared_consent";

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
        owner_id: r.get(9)?,
        sync_mail: r.get::<_, i64>(10)? != 0,
        shared_consent: r.get::<_, i64>(11)? != 0,
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
    pub meeting_type: Option<String>,
}

pub struct StoredBody {
    pub html: String,
    pub text: String,
    pub bcc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    pub attachments: Vec<Attachment>,
    pub unsubscribe: Option<Unsubscribe>,
    /// False for bodies cached before headers were read (fetch them once on open).
    pub headers_checked: bool,
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
        migrate(&conn)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- accounts ----------
    pub fn accounts(&self) -> Result<Vec<Account>> {
        let c = self.conn();
        let mut st = c.prepare(
            &format!("SELECT {ACCOUNT_COLS} FROM accounts ORDER BY sort, created_at"),
        )?;
        let rows = st.query_map([], account_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn account(&self, id: &str) -> Result<Option<Account>> {
        let c = self.conn();
        Ok(c.query_row(
            &format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?"),
            [id],
            account_from_row,
        )
        .optional()?)
    }

    pub fn upsert_account(&self, a: &Account) -> Result<()> {
        let c = self.conn();
        let sort: i64 = c.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM accounts", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO accounts (id, provider, email, display_name, hue, tenant_id, status, sort, owner_id, sync_mail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET email = excluded.email, tenant_id = excluded.tenant_id,
               sync_mail = excluded.sync_mail, status = 'ok', status_message = NULL",
            params![a.id, a.provider, a.email, a.display_name, a.hue, a.tenant_id, sort, a.owner_id, a.sync_mail as i64],
        )?;
        Ok(())
    }

    pub fn set_shared_consent(&self, id: &str) -> Result<()> {
        self.conn().execute("UPDATE accounts SET shared_consent = 1 WHERE id = ?", [id])?;
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

    /// Removes the account and the shared mailboxes / calendars opened through it.
    pub fn remove_account(&self, id: &str) -> Result<()> {
        let c = self.conn();
        c.execute(
            "DELETE FROM messages_fts WHERE rowid IN
               (SELECT rowid FROM messages WHERE account_id = ?1 OR account_id IN (SELECT id FROM accounts WHERE owner_id = ?1))",
            [id],
        )?;
        c.execute("DELETE FROM accounts WHERE id = ?1 OR owner_id = ?1", [id])?;
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
                   to_json, cc_json, preview, received_at, is_read, is_flagged, has_attachments, importance, web_link, is_draft, meeting_type)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                 ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id, conversation_id=excluded.conversation_id,
                   subject=excluded.subject, from_name=excluded.from_name, from_email=excluded.from_email,
                   to_json=excluded.to_json, cc_json=excluded.cc_json, preview=excluded.preview,
                   received_at=excluded.received_at, is_read=excluded.is_read, is_flagged=excluded.is_flagged,
                   has_attachments=excluded.has_attachments, importance=excluded.importance,
                   web_link=excluded.web_link, is_draft=excluded.is_draft,
                   meeting_type=COALESCE(excluded.meeting_type, messages.meeting_type)",
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
                    m.meeting_type,
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
            MessageView::Snoozed => {
                wh.push("m.id IN (SELECT message_id FROM snoozes)".into());
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
        // Snoozed mail stays out of every mailbox view until it wakes (search still finds it).
        if !matches!(q.view, MessageView::Snoozed | MessageView::Search { .. }) {
            wh.push("m.id NOT IN (SELECT message_id FROM snoozes)".into());
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
                   needs_reply=excluded.needs_reply, due_at=excluded.due_at,
                   suggested_reply = CASE WHEN excluded.needs_reply = 1 THEN annotations.suggested_reply ELSE NULL END",
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

    pub fn set_suggested_reply(&self, message_id: &str, text: Option<&str>) -> Result<()> {
        let c = self.conn();
        c.execute("UPDATE annotations SET suggested_reply = ? WHERE message_id = ?", params![text, message_id])?;
        Ok(())
    }

    /// Sent messages (last `days`) whose conversation has no later message from someone other than the sender.
    pub fn followups(&self, days: i64, limit: i64) -> Result<Vec<MessageSummary>> {
        let c = self.conn();
        let sql = format!(
            "SELECT {SUMMARY_COLS} FROM messages m LEFT JOIN annotations a ON a.message_id = m.id
             JOIN folders f ON f.id = m.folder_id AND f.well_known = 'sentitems'
             WHERE m.is_draft = 0
               AND m.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)
               AND m.received_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-18 hours')
               AND m.to_json <> '[]'
               AND NOT EXISTS (
                 SELECT 1 FROM messages r
                 WHERE r.account_id = m.account_id AND r.conversation_id = m.conversation_id AND m.conversation_id <> ''
                   AND r.received_at > m.received_at AND lower(r.from_email) <> lower(m.from_email))
               AND m.id = (
                 SELECT m2.id FROM messages m2 JOIN folders f2 ON f2.id = m2.folder_id AND f2.well_known = 'sentitems'
                 WHERE m2.account_id = m.account_id AND m2.conversation_id = m.conversation_id
                 AND m.id NOT IN (SELECT message_id FROM snoozes)
             ORDER BY m2.received_at DESC LIMIT 1)
             ORDER BY m.received_at DESC LIMIT ?2"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st
            .query_map(params![format!("-{} days", days.clamp(1, 90)), limit.clamp(1, 200)], summary_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Inbox messages with a triage deadline: overdue (up to 7 days) and upcoming, soonest first.
    pub fn due(&self, limit: i64) -> Result<Vec<MessageSummary>> {
        let c = self.conn();
        let sql = format!(
            "SELECT {SUMMARY_COLS} FROM messages m JOIN annotations a ON a.message_id = m.id
             WHERE a.due_at IS NOT NULL
               AND m.folder_id IN (SELECT id FROM folders WHERE well_known = 'inbox')
               AND a.due_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
             AND m.id NOT IN (SELECT message_id FROM snoozes)
             ORDER BY a.due_at ASC LIMIT ?"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map([limit.clamp(1, 200)], summary_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn set_meeting_type(&self, id: &str, meeting_type: &str) -> Result<()> {
        let c = self.conn();
        c.execute("UPDATE messages SET meeting_type = ? WHERE id = ?", params![meeting_type, id])?;
        Ok(())
    }

    // ---------- events ----------
    /// Replaces every cached event of the account whose start falls in [from, to) with `events`.
    pub fn replace_events(&self, account_id: &str, from: &str, to: &str, events: &[CalEvent]) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM events WHERE account_id = ?1 AND start_local >= ?2 AND start_local < ?3",
            params![account_id, from, to],
        )?;
        {
            let mut st = tx.prepare(
                "INSERT OR REPLACE INTO events (id, account_id, subject, start_local, end_local, tz, is_all_day, is_cancelled,
                   location, organizer_json, attendees_json, response, show_as, is_online, join_url, web_link, preview,
                   series_master_id, response_requested, calendar_id, event_type, reminder_minutes, sensitivity, importance,
                   categories_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
            )?;
            for e in events {
                st.execute(params![
                    e.id, account_id, e.subject, e.start, e.end, e.time_zone, e.is_all_day as i64, e.is_cancelled as i64,
                    e.location, e.organizer.as_ref().map(serde_json::to_string).transpose()?,
                    serde_json::to_string(&e.attendees)?, e.response, e.show_as, e.is_online as i64, e.join_url,
                    e.web_link, e.preview, e.series_master_id, e.response_requested as i64, e.calendar_id, e.event_type,
                    e.reminder_minutes, e.sensitivity, e.importance, serde_json::to_string(&e.categories)?
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_event(&self, e: &CalEvent) -> Result<()> {
        self.replace_events(&e.account_id, &e.start, &e.start, std::slice::from_ref(e))
    }

    /// Events overlapping [from, to) (local wall-clock strings), sorted by start.
    pub fn events(&self, from: &str, to: &str, account_id: Option<&str>) -> Result<Vec<CalEvent>> {
        let c = self.conn();
        let mut st = c.prepare(
            &format!("SELECT {EVENT_COLS} FROM events WHERE start_local < ?1 AND end_local > ?2 AND (?3 IS NULL OR account_id = ?3)
             ORDER BY start_local, end_local"),
        )?;
        let rows = st.query_map(params![to, from, account_id], row_event)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn event(&self, id: &str) -> Result<Option<CalEvent>> {
        let c = self.conn();
        Ok(c.query_row(&format!("SELECT {EVENT_COLS} FROM events WHERE id = ?1"), [id], row_event).optional()?)
    }

    pub fn delete_event(&self, id: &str) -> Result<()> {
        let c = self.conn();
        c.execute("DELETE FROM events WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Drops every cached occurrence of a series (after the series was deleted / cancelled).
    pub fn delete_series(&self, master_id: &str) -> Result<()> {
        let c = self.conn();
        c.execute("DELETE FROM events WHERE id = ?1 OR series_master_id = ?1", [master_id])?;
        Ok(())
    }

    // ---------- calendars ----------
    pub fn replace_calendars(&self, account_id: &str, cals: &[CalendarInfo]) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM calendars WHERE account_id = ?1", [account_id])?;
        {
            let mut st = tx.prepare(
                "INSERT OR REPLACE INTO calendars (id, account_id, name, color, is_default, can_edit, owner, sort) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for (i, k) in cals.iter().enumerate() {
                st.execute(params![k.id, account_id, k.name, k.color, k.is_default as i64, k.can_edit as i64, k.owner, i as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn calendars(&self, account_id: Option<&str>) -> Result<Vec<CalendarInfo>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT c.id, c.account_id, c.name, c.color, c.is_default, c.can_edit, c.owner FROM calendars c
             JOIN accounts a ON a.id = c.account_id
             WHERE (?1 IS NULL OR c.account_id = ?1) ORDER BY a.sort, a.created_at, c.is_default DESC, c.sort",
        )?;
        let rows = st
            .query_map(params![account_id], |r| {
                Ok(CalendarInfo {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                    is_default: r.get::<_, i64>(4)? != 0,
                    can_edit: r.get::<_, i64>(5)? != 0,
                    owner: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Case-insensitive search over subject, location, attendees, organizer and preview of every cached event.
    pub fn search_events(&self, query: &str, limit: i64) -> Result<Vec<CalEvent>> {
        let words: Vec<String> = query.split_whitespace().map(|w| format!("%{}%", w.to_lowercase().replace('%', ""))).collect();
        if words.is_empty() {
            return Ok(vec![]);
        }
        let c = self.conn();
        let hay = "lower(subject || ' ' || coalesce(location,'') || ' ' || attendees_json || ' ' || coalesce(organizer_json,'') || ' ' || preview)";
        let conds: Vec<String> = (1..=words.len()).map(|i| format!("{hay} LIKE ?{i}")).collect();
        let sql = format!(
            "SELECT {EVENT_COLS} FROM events WHERE {} ORDER BY abs(julianday(start_local) - julianday('now','localtime')) LIMIT {limit}",
            conds.join(" AND ")
        );
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(words.iter()), row_event)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Events on the same account that collide with `ev` and actually block time.
    pub fn conflicts(&self, ev: &CalEvent) -> Result<Vec<CalEvent>> {
        let all = self.events(&ev.start, &ev.end, Some(&ev.account_id))?;
        Ok(all
            .into_iter()
            .filter(|e| e.id != ev.id && !e.is_cancelled && !e.is_all_day && e.response != "declined" && e.show_as != "free")
            .filter(|e| e.series_master_id.is_none() || e.series_master_id != ev.series_master_id)
            .collect())
    }

    // ---------- snooze ----------
    pub fn snooze(&self, ids: &[String], until: &str) -> Result<()> {
        let c = self.conn();
        for id in ids {
            c.execute(
                "INSERT INTO snoozes (message_id, until) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?1)
                 ON CONFLICT(message_id) DO UPDATE SET until = excluded.until",
                params![id, until],
            )?;
        }
        Ok(())
    }

    pub fn unsnooze(&self, ids: &[String]) -> Result<()> {
        let c = self.conn();
        for id in ids {
            c.execute("DELETE FROM snoozes WHERE message_id = ?1", [id])?;
        }
        Ok(())
    }

    /// Removes and returns snoozes whose time has come (`now` = UTC ISO "…Z").
    pub fn take_due_snoozes(&self, now: &str) -> Result<Vec<String>> {
        let c = self.conn();
        let ids: Vec<String> = c
            .prepare("SELECT message_id FROM snoozes WHERE until <= ?1")?
            .query_map([now], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        c.execute("DELETE FROM snoozes WHERE until <= ?1", [now])?;
        Ok(ids)
    }

    pub fn snoozed_count(&self) -> Result<i64> {
        let c = self.conn();
        Ok(c.query_row("SELECT count(*) FROM snoozes", [], |r| r.get(0))?)
    }

    // ---------- event notes ----------
    pub fn event_note(&self, event_id: &str) -> Result<Option<String>> {
        let c = self.conn();
        Ok(c.query_row("SELECT text FROM event_notes WHERE event_id = ?1", [event_id], |r| r.get(0)).optional()?)
    }

    pub fn set_event_note(&self, event_id: &str, text: &str) -> Result<()> {
        let c = self.conn();
        if text.trim().is_empty() {
            c.execute("DELETE FROM event_notes WHERE event_id = ?1", [event_id])?;
        } else {
            c.execute(
                "INSERT INTO event_notes (event_id, text, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                 ON CONFLICT(event_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                params![event_id, text],
            )?;
        }
        Ok(())
    }

    /// Which of `ids` have notes (for the note marker on events).
    pub fn event_ids_with_notes(&self) -> Result<Vec<String>> {
        let c = self.conn();
        let ids = c.prepare("SELECT event_id FROM event_notes")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    pub fn set_unsubscribe(&self, id: &str, u: &Option<Unsubscribe>) -> Result<()> {
        let c = self.conn();
        c.execute("UPDATE bodies SET unsubscribe_json = ?1 WHERE message_id = ?2", params![serde_json::to_string(u)?, id])?;
        Ok(())
    }

    // ---------- bodies ----------
    /// Recent messages (any folder, inbox first, newest first) whose body is not cached yet.
    pub fn ids_without_body(&self, account_id: &str, limit: i64) -> Result<Vec<String>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT m.id FROM messages m
             JOIN folders f ON f.id = m.folder_id
             LEFT JOIN bodies b ON b.message_id = m.id
             WHERE m.account_id = ?1 AND b.message_id IS NULL AND m.is_draft = 0
               AND m.received_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-60 days')
               AND f.well_known IS NOT 'junkemail' AND f.well_known IS NOT 'deleteditems'
             ORDER BY (f.well_known = 'inbox') DESC, m.received_at DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![account_id, limit], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn body(&self, id: &str) -> Result<Option<StoredBody>> {
        let c = self.conn();
        Ok(c.query_row(
            "SELECT html, text, bcc_json, reply_to_json, attachments_json, unsubscribe_json FROM bodies WHERE message_id = ?",
            [id],
            |r| {
                let unsub: Option<String> = r.get(5)?;
                Ok(StoredBody {
                    html: r.get(0)?,
                    text: r.get(1)?,
                    bcc: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
                    reply_to: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                    attachments: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                    headers_checked: unsub.is_some(),
                    unsubscribe: unsub.and_then(|s| serde_json::from_str(&s).ok()).flatten(),
                })
            },
        )
        .optional()?)
    }

    pub fn set_body(&self, id: &str, b: &StoredBody) -> Result<()> {
        let c = self.conn();
        c.execute(
            "INSERT OR REPLACE INTO bodies (message_id, html, text, bcc_json, reply_to_json, attachments_json, unsubscribe_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                b.html,
                b.text,
                serde_json::to_string(&b.bcc)?,
                serde_json::to_string(&b.reply_to)?,
                serde_json::to_string(&b.attachments)?,
                if b.headers_checked { Some(serde_json::to_string(&b.unsubscribe)?) } else { None },
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
            meeting_type: None,
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
            owner_id: None,
            sync_mail: true,
            shared_consent: false,
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
    fn snooze_hides_until_due() {
        let db = mem();
        seed(&db);
        db.upsert_messages(&[msg("m1", "inbox", "Invoice", "2026-10-05T10:00:00Z"), msg("m2", "inbox", "Hello", "2026-10-06T09:00:00Z")]).unwrap();
        let q = |view| MessageQuery { view, account_id: None, unread_only: false, limit: 50, before: None };
        db.snooze(&["m1".into()], "2026-10-07T07:00:00Z").unwrap();
        let inbox: Vec<String> = db.list(&q(MessageView::Unified { well_known: "inbox".into() })).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(inbox, vec!["m2"]);
        let snoozed = db.list(&q(MessageView::Snoozed)).unwrap();
        assert_eq!(snoozed.len(), 1);
        assert_eq!(snoozed[0].snoozed_until.as_deref(), Some("2026-10-07T07:00:00Z"));
        // search still finds snoozed mail
        assert_eq!(db.list(&q(MessageView::Search { query: "invoice".into() })).unwrap().len(), 1);
        assert!(db.take_due_snoozes("2026-10-07T06:59:59Z").unwrap().is_empty());
        assert_eq!(db.take_due_snoozes("2026-10-07T07:00:00Z").unwrap(), vec!["m1"]);
        assert_eq!(db.list(&q(MessageView::Unified { well_known: "inbox".into() })).unwrap().len(), 2);
        // snoozing an unknown id is a no-op
        db.snooze(&["nope".into()], "2030-01-01T00:00:00Z").unwrap();
        assert_eq!(db.snoozed_count().unwrap(), 0);
    }

    #[test]
    fn event_notes_roundtrip() {
        let db = mem();
        db.set_event_note("e1", "Agreed on Q4 budget").unwrap();
        assert_eq!(db.event_note("e1").unwrap().as_deref(), Some("Agreed on Q4 budget"));
        assert_eq!(db.event_ids_with_notes().unwrap(), vec!["e1"]);
        db.set_event_note("e1", "  ").unwrap();
        assert!(db.event_note("e1").unwrap().is_none());
    }

    #[test]
    fn shared_accounts_follow_their_owner() {
        let db = mem();
        seed(&db);
        let shared = Account {
            id: "shared-a1-info@emcap.se".into(),
            provider: "microsoft".into(),
            email: "info@emcap.se".into(),
            display_name: "Info".into(),
            hue: 90,
            tenant_id: None,
            last_sync: None,
            status: "ok".into(),
            status_message: None,
            owner_id: Some("a1".into()),
            sync_mail: false,
            shared_consent: false,
        };
        db.upsert_account(&shared).unwrap();
        db.set_shared_consent("a1").unwrap();
        let got = db.account(&shared.id).unwrap().unwrap();
        assert_eq!(got.owner_id.as_deref(), Some("a1"));
        assert!(!got.sync_mail);
        assert!(db.account("a1").unwrap().unwrap().shared_consent);
        db.remove_account("a1").unwrap();
        assert!(db.accounts().unwrap().is_empty());
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
        db.set_body("m2", &StoredBody { html: "<p>pizza</p>".into(), text: "pizza at noon".into(), bcc: vec![], reply_to: vec![], attachments: vec![], unsubscribe: None, headers_checked: true })
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
            suggested_reply: None,
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

    fn ev(id: &str, start: &str, end: &str) -> CalEvent {
        CalEvent {
            id: id.into(), account_id: "a1".into(), subject: id.into(), start: start.into(), end: end.into(),
            time_zone: "Europe/Stockholm".into(), is_all_day: false, is_cancelled: false, location: None, organizer: None,
            attendees: vec![], response: "accepted".into(), show_as: "busy".into(), is_online: false, join_url: None,
            web_link: None, preview: String::new(), series_master_id: None, response_requested: true,
            calendar_id: String::new(), event_type: "singleInstance".into(), reminder_minutes: Some(15),
            sensitivity: "normal".into(), importance: "normal".into(), categories: vec![],
        }
    }

    #[test]
    fn events_window_and_conflicts() {
        let db = mem();
        seed(&db);
        db.replace_events("a1", "2026-10-05T00:00:00", "2026-10-12T00:00:00", &[
            ev("standup", "2026-10-06T09:00:00", "2026-10-06T09:15:00"),
            ev("board", "2026-10-06T10:00:00", "2026-10-06T11:00:00"),
            ev("lunch", "2026-10-06T12:00:00", "2026-10-06T13:00:00"),
        ]).unwrap();
        // a later re-sync of the same window drops events that disappeared and keeps order
        db.replace_events("a1", "2026-10-05T00:00:00", "2026-10-12T00:00:00", &[
            ev("board", "2026-10-06T10:00:00", "2026-10-06T11:00:00"),
            ev("lunch", "2026-10-06T12:00:00", "2026-10-06T13:00:00"),
        ]).unwrap();
        let day: Vec<String> = db.events("2026-10-06T00:00:00", "2026-10-07T00:00:00", None).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(day, vec!["board", "lunch"]);
        // overlap query is half-open: an event ending exactly at `from` is excluded
        assert!(db.events("2026-10-06T11:00:00", "2026-10-06T12:00:00", None).unwrap().is_empty());

        let invite = ev("invite", "2026-10-06T10:30:00", "2026-10-06T12:30:00");
        let c: Vec<String> = db.conflicts(&invite).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(c, vec!["board", "lunch"]);
        // declined / free / cancelled events don't count as conflicts
        let mut free = ev("focus", "2026-10-06T10:00:00", "2026-10-06T12:00:00");
        free.show_as = "free".into();
        db.upsert_event(&free).unwrap();
        assert_eq!(db.conflicts(&invite).unwrap().len(), 2);
    }

    fn at(hours_ago: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::hours(hours_ago)).format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    #[test]
    fn followups_due_and_predrafts() {
        let db = mem();
        seed(&db);
        let mut sent = Folder { id: "sent".into(), account_id: "a1".into(), name: "Sent".into(), well_known: Some("sentitems".into()), parent_id: None, unread: 0, total: 0 };
        let mut all = db.folders(Some("a1")).unwrap();
        all.push(sent.clone());
        db.replace_folders("a1", &all).unwrap();
        sent.total = 3;

        let mine = |id: &str, conv: &str, h: i64| {
            let mut m = msg(id, "sent", "Proposal", &at(h));
            m.conversation_id = conv.into();
            m.from = Addr { name: "John".into(), email: "john@emcap.se".into() };
            m
        };
        let theirs = |id: &str, conv: &str, h: i64| {
            let mut m = msg(id, "inbox", "Re: Proposal", &at(h));
            m.conversation_id = conv.into();
            m
        };
        db.upsert_messages(&[
            mine("s1", "c-waiting", 72),            // no reply -> follow-up
            mine("s2", "c-answered", 96), theirs("r2", "c-answered", 50), // answered -> not
            mine("s3", "c-twice", 120), mine("s4", "c-twice", 60),         // nudged already; latest counts once
            mine("s5", "c-fresh", 2),               // too recent (< 18h)
        ]).unwrap();
        let f = db.followups(14, 50).unwrap();
        let ids: Vec<&str> = f.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["s4", "s1"]);

        // deadlines: soonest first, overdue within a week kept, ancient dropped
        db.upsert_messages(&[theirs("d1", "x1", 5), theirs("d2", "x2", 6), theirs("d3", "x3", 7)]).unwrap();
        let ann = |id: &str, due: Option<String>, reply: bool| Annotation {
            message_id: id.into(), category: "action".into(), priority: 2, summary: "s".into(),
            action_items: vec![], needs_reply: reply, due_at: due, suggested_reply: None,
        };
        db.set_annotations(&[
            ann("d1", Some(at(-48)), true),   // in two days
            ann("d2", Some(at(24)), false),   // yesterday (overdue)
            ann("d3", Some(at(24 * 30)), false), // a month ago -> dropped
        ]).unwrap();
        let due: Vec<String> = db.due(10).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(due, vec!["d2", "d1"]);

        // pre-drafts survive a triage re-run for needs_reply mail, are cleared otherwise
        db.set_suggested_reply("d1", Some("Happy to — Thursday works.")).unwrap();
        db.set_annotations(&[ann("d1", None, true)]).unwrap();
        assert_eq!(db.summary("d1").unwrap().unwrap().ai.unwrap().suggested_reply.as_deref(), Some("Happy to — Thursday works."));
        db.set_annotations(&[ann("d1", None, false)]).unwrap();
        assert_eq!(db.summary("d1").unwrap().unwrap().ai.unwrap().suggested_reply, None);
    }
}
