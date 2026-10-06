//! Background sync: folders + per-folder delta queries, polled on an interval or on demand.
use crate::auth::AuthError;
use crate::graph::{self, GraphError};
use crate::model::*;
use crate::state::AppState;
use anyhow::Result;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Folders synced every cycle. Other folders sync when they have content but less often.
const PRIORITY: [&str; 6] = ["inbox", "sentitems", "drafts", "archive", "deleteditems", "junkemail"];

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let st = app.state::<Arc<AppState>>().inner().clone();
        let mut cycle: u64 = 0;
        loop {
            for acc in st.db.accounts().unwrap_or_default() {
                if acc.status == "reauth" && cycle % 10 != 0 {
                    continue;
                }
                sync_account(&app, &st, &acc, cycle % 5 == 0).await;
            }
            cycle += 1;
            let interval = crate::settings::sync_interval(&st.settings.read().unwrap());
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                _ = st.sync_kick.notified() => {}
            }
        }
    });
}

fn emit_status(app: &AppHandle, st: &AppState, account_id: &str, state: &str, message: Option<String>) {
    let last_sync = st.db.account(account_id).ok().flatten().and_then(|a| a.last_sync);
    let _ = app.emit(
        "sync://status",
        SyncStatusEvent { account_id: account_id.to_string(), state: state.to_string(), message, last_sync },
    );
}

pub async fn sync_account(app: &AppHandle, st: &AppState, acc: &Account, include_other_folders: bool) {
    emit_status(app, st, &acc.id, "syncing", None);
    match sync_inner(app, st, acc, include_other_folders).await {
        Ok(()) => {
            // Calendar problems (e.g. a mailbox without one) must not mark mail sync as failed.
            if let Err(e) = crate::calendar::sync_account(app, st, acc).await {
                log::warn!("calendar sync failed for {}: {e:#}", acc.email);
            }
            let _ = st.db.set_account_status(&acc.id, "ok", None, true);
            emit_status(app, st, &acc.id, "idle", None);
            prefetch_bodies(st, acc).await;
        }
        Err(e) => {
            let reauth = e.downcast_ref::<AuthError>().is_some();
            let msg = e.to_string();
            let status = if reauth { "reauth" } else { "error" };
            let _ = st.db.set_account_status(&acc.id, status, Some(&msg), false);
            emit_status(app, st, &acc.id, status, Some(msg));
            if reauth {
                let _ = app.emit("accounts://changed", ());
            }
        }
    }
}

/// Wakes snoozed messages: marks them unread again, refreshes the lists and shows a notification.
pub fn start_snooze_waker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let st = app.state::<Arc<AppState>>().inner().clone();
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let ids = match st.db.take_due_snoozes(&now) {
                Ok(ids) if !ids.is_empty() => ids,
                _ => continue,
            };
            let mut woke: Vec<MessageSummary> = Vec::new();
            for id in &ids {
                let Ok(Some(m)) = st.db.summary(id) else { continue };
                let _ = st.db.set_read(std::slice::from_ref(id), false);
                if let Err(e) = graph::patch(&st, &m.account_id, id, serde_json::json!({ "isRead": false })).await {
                    log::warn!("snooze wake: could not mark unread: {e:#}");
                }
                let _ = app.emit("mail://changed", MailChangedEvent { account_id: m.account_id.clone(), folder_ids: vec![m.folder_id.clone()], new_message_ids: vec![] });
                woke.push(m);
            }
            if woke.is_empty() {
                continue;
            }
            let (title, body) = if woke.len() == 1 {
                let m = &woke[0];
                (format!("Back from snooze · {}", if m.from.name.is_empty() { &m.from.email } else { &m.from.name }), m.subject.clone())
            } else {
                (format!("{} messages are back from snooze", woke.len()), woke.iter().take(3).map(|m| m.subject.clone()).collect::<Vec<_>>().join("\n"))
            };
            let _ = app.notification().builder().title(title).body(body).show();
            let _ = app.emit("snooze://woke", woke.iter().map(|m| m.id.clone()).collect::<Vec<_>>());
        }
    });
}

/// Downloads bodies of recent messages in the background so opening mail is instant and body search works
/// without a round trip. A bounded batch per cycle keeps Graph throttling and bandwidth in check.
const PREFETCH_PER_CYCLE: i64 = 40;

async fn prefetch_bodies(st: &AppState, acc: &Account) {
    if !crate::settings::prefetch_bodies(&st.settings.read().unwrap()) {
        return;
    }
    let ids = match st.db.ids_without_body(&acc.id, PREFETCH_PER_CYCLE) {
        Ok(ids) => ids,
        Err(_) => return,
    };
    for id in ids {
        // The user may have opened it meanwhile.
        if st.db.body(&id).ok().flatten().is_some() {
            continue;
        }
        match graph::body(st, &acc.id, &id).await {
            Ok(b) => {
                let _ = st.db.set_body(&id, &b);
            }
            Err(e) => {
                // Deleted since the sync, or throttled: stop this batch, the next cycle retries.
                if let Some(g) = e.downcast_ref::<GraphError>() {
                    if g.status == 404 {
                        continue;
                    }
                }
                log::debug!("body prefetch stopped for {}: {e:#}", acc.email);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

async fn sync_inner(app: &AppHandle, st: &AppState, acc: &Account, include_other_folders: bool) -> Result<()> {
    let folders = graph::folders(st, &acc.id).await?;
    st.db.replace_folders(&acc.id, &folders)?;
    let _ = app.emit(
        "mail://changed",
        MailChangedEvent { account_id: acc.id.clone(), folder_ids: vec![], new_message_ids: vec![] },
    );

    let mut ordered: Vec<&Folder> = PRIORITY
        .iter()
        .filter_map(|wk| folders.iter().find(|f| f.well_known.as_deref() == Some(*wk)))
        .collect();
    if include_other_folders {
        ordered.extend(folders.iter().filter(|f| f.well_known.is_none() && f.total > 0));
    }

    for f in ordered {
        if let Err(e) = sync_folder(app, st, acc, f).await {
            // A stale delta token (410 / syncStateNotFound) means: start over.
            if let Some(g) = e.downcast_ref::<GraphError>() {
                if g.status == 410 || g.code.contains("syncState") || g.code.contains("resyncRequired") {
                    st.db.set_delta_link(&acc.id, &f.id, None)?;
                    sync_folder(app, st, acc, f).await?;
                    continue;
                }
            }
            return Err(e);
        }
    }
    Ok(())
}

async fn sync_folder(app: &AppHandle, st: &AppState, acc: &Account, f: &Folder) -> Result<()> {
    let initial = st.db.delta_link(&acc.id, &f.id)?.is_none();
    let mut url = st.db.delta_link(&acc.id, &f.id)?.unwrap_or_else(|| graph::initial_delta_url(&f.id));
    let is_inbox = f.well_known.as_deref() == Some("inbox");
    let mut fresh: Vec<MessageSummary> = Vec::new();
    loop {
        let page = graph::delta_page(st, &acc.id, &f.id, &url).await?;
        let new_ids = st.db.upsert_messages(&page.items)?;
        for id in &page.removed {
            st.db.remove_message_from_folder(id, &f.id)?;
        }
        if !page.items.is_empty() || !page.removed.is_empty() {
            let new_inbox: Vec<String> = if is_inbox { new_ids.clone() } else { vec![] };
            if !initial && is_inbox {
                let cutoff = (chrono::Utc::now() - chrono::Duration::hours(2)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
                let ids: HashSet<&String> = new_ids.iter().collect();
                fresh.extend(
                    page.items
                        .iter()
                        .filter(|m| ids.contains(&m.id) && !m.is_read && m.received_at > cutoff)
                        .filter_map(|m| st.db.summary(&m.id).ok().flatten()),
                );
            }
            let _ = app.emit(
                "mail://changed",
                MailChangedEvent { account_id: acc.id.clone(), folder_ids: vec![f.id.clone()], new_message_ids: new_inbox },
            );
        }
        if let Some(next) = page.next_link {
            url = next;
            continue;
        }
        if let Some(delta) = page.delta_link {
            st.db.set_delta_link(&acc.id, &f.id, Some(&delta))?;
        }
        break;
    }
    if !fresh.is_empty() {
        notify(app, acc, &fresh);
    }
    Ok(())
}

fn notify(app: &AppHandle, acc: &Account, msgs: &[MessageSummary]) {
    // Don't notify while the user is looking at the app.
    if let Some(w) = app.get_webview_window("main") {
        if w.is_focused().unwrap_or(false) {
            return;
        }
    }
    let (title, body) = if msgs.len() == 1 {
        let m = &msgs[0];
        let who = if m.from.name.is_empty() { m.from.email.clone() } else { m.from.name.clone() };
        (who, if m.subject.is_empty() { m.preview.clone() } else { m.subject.clone() })
    } else {
        (
            format!("{} new messages · {}", msgs.len(), acc.email),
            msgs.iter()
                .take(3)
                .map(|m| format!("{}: {}", if m.from.name.is_empty() { &m.from.email } else { &m.from.name }, m.subject))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    let _ = app.notification().builder().title(title).body(body).show();
}
