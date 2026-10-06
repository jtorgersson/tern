//! Tauri commands — the API surface used by src/lib/api.ts.
use crate::model::*;
use crate::state::AppState;
use crate::{auth, calendar, graph, secrets, settings, theme};
use futures::future::join_all;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type R<T> = Result<T, String>;
type St<'a> = State<'a, Arc<AppState>>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn account_of(st: &AppState, id: &str) -> R<String> {
    st.db
        .message_meta(id)
        .map_err(err)?
        .map(|(acc, _, _)| acc)
        .ok_or_else(|| "Message not found (it may have been moved or deleted)".to_string())
}

/// Only AI provider keys are readable from the webview; account tokens never leave Rust.
fn check_secret_key(key: &str) -> R<()> {
    if key.starts_with("ai:") {
        Ok(())
    } else {
        Err("secret not accessible".into())
    }
}

// ---------------- app / settings / theme ----------------

#[tauri::command]
pub fn app_bootstrap(st: St) -> R<Bootstrap> {
    Ok(Bootstrap {
        accounts: st.db.accounts().map_err(err)?,
        settings: st.settings.read().unwrap().clone(),
        theme: theme::load(),
    })
}

#[tauri::command]
pub fn theme_get() -> Theme {
    theme::load()
}

#[tauri::command]
pub fn settings_get(st: St) -> serde_json::Value {
    st.settings.read().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(st: St, settings: serde_json::Value) -> R<serde_json::Value> {
    let saved = settings::save(&settings).map_err(err)?;
    *st.settings.write().unwrap() = saved.clone();
    Ok(saved)
}

#[tauri::command]
pub fn secret_set(key: String, value: Option<String>) -> R<()> {
    check_secret_key(&key)?;
    match value.filter(|v| !v.is_empty()) {
        Some(v) => secrets::set(&key, &v).map_err(err),
        None => secrets::delete(&key).map_err(err),
    }
}

#[tauri::command]
pub fn secret_get(key: String) -> R<Option<String>> {
    check_secret_key(&key)?;
    secrets::get(&key).map_err(err)
}

// ---------------- accounts ----------------

#[tauri::command]
pub fn accounts_list(st: St) -> R<Vec<Account>> {
    st.db.accounts().map_err(err)
}

fn progress(app: &AppHandle, state: &str, message: Option<String>) {
    let _ = app.emit("auth://progress", AuthProgressEvent { state: state.into(), message });
}

#[tauri::command]
pub async fn account_add_microsoft(app: AppHandle, st: St<'_>) -> R<Account> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Some(prev) = st.auth_cancel.lock().unwrap().replace(tx) {
        let _ = prev.send(());
    }
    let s = st.settings.read().unwrap().clone();
    let client_id = settings::ms_client_id(&s);
    let tenant = settings::ms_tenant(&s);
    let result = async {
        let sign_in = auth::interactive(
            &st.http,
            &client_id,
            &tenant,
            rx,
            || progress(&app, "waiting_browser", None),
            || progress(&app, "exchanging", None),
        )
        .await?;
        let (uid, email, name) = graph::me(&st.http, &sign_in.access_token).await?;
        let id = format!("ms-{uid}");
        let existing = st.db.account(&id)?;
        let n = st.db.accounts()?.len() as i64;
        let account = Account {
            id: id.clone(),
            provider: "microsoft".into(),
            email,
            display_name: existing.as_ref().map(|a| a.display_name.clone()).unwrap_or(name),
            // Golden-angle spacing keeps account colours distinct; first one sits on the theme accent.
            hue: existing.as_ref().map(|a| a.hue).unwrap_or(if n == 0 { -1 } else { (n * 137 + 210) % 360 }),
            tenant_id: sign_in.tenant_id,
            last_sync: None,
            status: "ok".into(),
            status_message: None,
        };
        secrets::set(&auth::refresh_key(&id), &sign_in.refresh_token)?;
        auth::cache_token(&st, &id, &sign_in.access_token);
        st.db.upsert_account(&account)?;
        anyhow::Ok(st.db.account(&id)?.unwrap_or(account))
    }
    .await;
    st.auth_cancel.lock().unwrap().take();
    match result {
        Ok(acc) => {
            progress(&app, "done", None);
            let _ = app.emit("accounts://changed", ());
            st.sync_kick.notify_one();
            Ok(acc)
        }
        Err(e) => {
            let msg = format!("{e:#}");
            progress(&app, "error", Some(msg.clone()));
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn auth_cancel(st: St) {
    if let Some(tx) = st.auth_cancel.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub fn account_remove(app: AppHandle, st: St, account_id: String) -> R<()> {
    st.db.remove_account(&account_id).map_err(err)?;
    let _ = secrets::delete(&auth::refresh_key(&account_id));
    st.tokens.lock().unwrap().remove(&account_id);
    let _ = app.emit("accounts://changed", ());
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPatch {
    display_name: Option<String>,
    hue: Option<i64>,
}

#[tauri::command]
pub fn account_update(app: AppHandle, st: St, account_id: String, patch: AccountPatch) -> R<Account> {
    st.db.update_account(&account_id, patch.display_name.as_deref(), patch.hue).map_err(err)?;
    let _ = app.emit("accounts://changed", ());
    st.db.account(&account_id).map_err(err)?.ok_or_else(|| "no such account".into())
}

// ---------------- reading ----------------

#[tauri::command]
pub fn folders_list(st: St, account_id: Option<String>) -> R<Vec<Folder>> {
    st.db.folders(account_id.as_deref()).map_err(err)
}

#[tauri::command]
pub fn messages_list(st: St, query: MessageQuery) -> R<Vec<MessageSummary>> {
    st.db.list(&query).map_err(err)
}

async fn load_full(st: &AppState, id: &str) -> anyhow::Result<MessageFull> {
    let summary = st.db.summary(id)?.ok_or_else(|| anyhow::anyhow!("Message not found (it may have been moved or deleted)"))?;
    let body = match st.db.body(id)? {
        Some(b) => b,
        None => {
            let b = graph::body(st, &summary.account_id, id).await?;
            st.db.set_body(id, &b)?;
            b
        }
    };
    Ok(MessageFull {
        cc: st.db.cc_of(id)?,
        web_link: st.db.web_link(id)?,
        summary,
        bcc: body.bcc,
        reply_to: body.reply_to,
        body_html: body.html,
        body_text: body.text,
        attachments: body.attachments,
    })
}

#[tauri::command]
pub async fn message_get(st: St<'_>, id: String) -> R<MessageFull> {
    load_full(&st, &id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn thread_get(st: St<'_>, id: String) -> R<Vec<MessageFull>> {
    let ids = st.db.conversation_ids(&id).map_err(err)?;
    let results = join_all(ids.iter().map(|i| load_full(&st, i))).await;
    let mut out = Vec::new();
    for r in results {
        match r {
            Ok(m) => out.push(m),
            Err(e) => log::warn!("thread message failed: {e:#}"),
        }
    }
    if out.is_empty() {
        out.push(load_full(&st, &id).await.map_err(|e| format!("{e:#}"))?);
    }
    Ok(out)
}

// ---------------- mutations ----------------

fn changed(app: &AppHandle, account_id: &str) {
    let _ = app.emit(
        "mail://changed",
        MailChangedEvent { account_id: account_id.to_string(), folder_ids: vec![], new_message_ids: vec![] },
    );
}

#[tauri::command]
pub async fn messages_set_read(app: AppHandle, st: St<'_>, ids: Vec<String>, read: bool) -> R<()> {
    st.db.set_read(&ids, read).map_err(err)?;
    let results = join_all(ids.iter().map(|id| {
        let st = st.inner().clone();
        async move {
            let acc = account_of(&st, id)?;
            graph::patch(&st, &acc, id, json!({ "isRead": read })).await.map_err(err)?;
            R::Ok(acc)
        }
    }))
    .await;
    finish(&app, &st, &ids, results, || {
        let _ = st.db.set_read(&ids, !read);
    })
}

#[tauri::command]
pub async fn messages_set_flag(app: AppHandle, st: St<'_>, ids: Vec<String>, flagged: bool) -> R<()> {
    st.db.set_flag(&ids, flagged).map_err(err)?;
    let status = if flagged { "flagged" } else { "notFlagged" };
    let results = join_all(ids.iter().map(|id| {
        let st = st.inner().clone();
        async move {
            let acc = account_of(&st, id)?;
            graph::patch(&st, &acc, id, json!({ "flag": { "flagStatus": status } })).await.map_err(err)?;
            R::Ok(acc)
        }
    }))
    .await;
    finish(&app, &st, &ids, results, || {
        let _ = st.db.set_flag(&ids, !flagged);
    })
}

fn finish(app: &AppHandle, _st: &AppState, _ids: &[String], results: Vec<R<String>>, revert: impl FnOnce()) -> R<()> {
    let mut accounts: Vec<String> = results.iter().filter_map(|r| r.as_ref().ok().cloned()).collect();
    accounts.dedup();
    let first_err = results.into_iter().find_map(|r| r.err());
    if first_err.is_some() && accounts.is_empty() {
        revert();
    }
    for a in &accounts {
        changed(app, a);
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

async fn move_one(st: &AppState, id: &str, destination: &str) -> R<String> {
    let (acc, from_folder, _) = st.db.message_meta(id).map_err(err)?.ok_or("Message not found")?;
    let dest_id = if graph::WELL_KNOWN.contains(&destination) {
        st.db.folder_by_well_known(&acc, destination).map_err(err)?
    } else {
        Some(destination.to_string())
    };
    if let Some(d) = &dest_id {
        if *d == from_folder {
            return Ok(acc);
        }
        st.db.set_folder(id, d).map_err(err)?;
    }
    match graph::move_to(st, &acc, id, dest_id.as_deref().unwrap_or(destination)).await {
        Ok(_) => Ok(acc),
        Err(e) => {
            let _ = st.db.set_folder(id, &from_folder);
            Err(format!("{e:#}"))
        }
    }
}

#[tauri::command]
pub async fn messages_move(app: AppHandle, st: St<'_>, ids: Vec<String>, destination: String) -> R<()> {
    let results = join_all(ids.iter().map(|id| move_one(&st, id, &destination))).await;
    finish(&app, &st, &ids, results, || {})
}

#[tauri::command]
pub async fn messages_delete(app: AppHandle, st: St<'_>, ids: Vec<String>) -> R<()> {
    let results = join_all(ids.iter().map(|id| {
        let st = st.inner().clone();
        async move {
            let (acc, folder, _) = st.db.message_meta(id).map_err(err)?.ok_or("Message not found")?;
            if st.db.folder_well_known(&folder).map_err(err)?.as_deref() == Some("deleteditems") {
                graph::delete(&st, &acc, id).await.map_err(|e| format!("{e:#}"))?;
                st.db.delete_messages(std::slice::from_ref(id)).map_err(err)?;
                Ok(acc)
            } else {
                move_one(&st, id, "deleteditems").await
            }
        }
    }))
    .await;
    finish(&app, &st, &ids, results, || {})
}

#[tauri::command]
pub async fn message_send(st: St<'_>, message: OutgoingMessage) -> R<()> {
    let is_reply = message.mode == "reply" || message.mode == "replyAll";
    if !is_reply && message.to.is_empty() && message.cc.is_empty() && message.bcc.is_empty() {
        return Err("Add at least one recipient".into());
    }
    let r = if message.mode == "new" { graph::send_new(&st, &message).await } else { graph::send_response(&st, &message).await };
    r.map_err(|e| format!("{e:#}"))?;
    let st2 = st.inner().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        st2.sync_kick.notify_one();
    });
    Ok(())
}

#[tauri::command]
pub async fn attachment_save(st: St<'_>, message_id: String, attachment_id: String) -> R<String> {
    let acc = account_of(&st, &message_id)?;
    let body = st.db.body(&message_id).map_err(err)?;
    let name = body
        .and_then(|b| b.attachments.into_iter().find(|a| a.id == attachment_id).map(|a| a.name))
        .unwrap_or_else(|| "attachment".into());
    let bytes = graph::attachment_bytes(&st, &acc, &message_id, &attachment_id).await.map_err(|e| format!("{e:#}"))?;
    let dir = dirs::download_dir().or_else(dirs::home_dir).ok_or("no download directory")?;
    let clean: String = name.chars().map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c }).collect();
    let clean = clean.trim_start_matches('.').to_string();
    let clean = if clean.is_empty() { "attachment".to_string() } else { clean };
    let (stem, ext) = match clean.rfind('.') {
        Some(i) if i > 0 => (clean[..i].to_string(), clean[i..].to_string()),
        _ => (clean.clone(), String::new()),
    };
    let mut path = dir.join(&clean);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    tokio::fs::write(&path, bytes).await.map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn sync_now(st: St, account_id: Option<String>) {
    let _ = account_id; // the loop syncs every account; cheap when nothing changed
    st.sync_kick.notify_one();
}

#[tauri::command]
pub fn contacts_suggest(st: St, prefix: String, limit: i64) -> R<Vec<Contact>> {
    st.db.contacts(&prefix, limit).map_err(err)
}

#[tauri::command]
pub fn annotations_set(st: St, items: Vec<Annotation>) -> R<()> {
    st.db.set_annotations(&items).map_err(err)
}

#[tauri::command]
pub fn messages_untriaged(st: St, limit: i64) -> R<Vec<MessageSummary>> {
    st.db.untriaged(limit).map_err(err)
}

#[tauri::command]
pub fn take_pending_mailto(st: St) -> Option<String> {
    st.pending_mailto.lock().unwrap().take()
}

#[tauri::command]
pub fn annotation_set_reply(st: St, message_id: String, text: Option<String>) -> R<()> {
    st.db.set_suggested_reply(&message_id, text.as_deref().filter(|t| !t.trim().is_empty())).map_err(err)
}

#[tauri::command]
pub fn followups_list(st: St, days: Option<i64>, limit: Option<i64>) -> R<Vec<MessageSummary>> {
    st.db.followups(days.unwrap_or(14), limit.unwrap_or(50)).map_err(err)
}

#[tauri::command]
pub fn messages_due(st: St, limit: Option<i64>) -> R<Vec<MessageSummary>> {
    st.db.due(limit.unwrap_or(20)).map_err(err)
}

// ---------------- calendar ----------------

#[tauri::command]
pub fn calendar_events(st: St, from: String, to: String, account_id: Option<String>) -> R<Vec<CalEvent>> {
    st.db.events(&from, &to, account_id.as_deref()).map_err(err)
}

#[tauri::command]
pub fn calendar_sync(st: St) {
    st.sync_kick.notify_one();
}

#[tauri::command]
pub async fn invite_get(st: St<'_>, message_id: String) -> R<Option<InviteInfo>> {
    calendar::invite(&st, &message_id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn invite_respond(
    app: AppHandle,
    st: St<'_>,
    account_id: String,
    event_id: String,
    action: String,
    comment: Option<String>,
    send_response: Option<bool>,
) -> R<()> {
    graph::respond_event(&st, &account_id, &event_id, &action, comment.as_deref(), send_response.unwrap_or(true))
        .await
        .map_err(|e| format!("{e:#}"))?;
    // Reflect it locally right away; the next calendar sync confirms.
    let response = match action.as_str() {
        "accept" => "accepted",
        "tentativelyAccept" => "tentativelyAccepted",
        _ => "declined",
    };
    if let Ok(evs) = st.db.events("0000", "9999", Some(&account_id)) {
        if let Some(mut ev) = evs.into_iter().find(|e| e.id == event_id) {
            ev.response = response.into();
            let _ = st.db.upsert_event(&ev);
        }
    }
    let _ = app.emit("calendar://changed", json!({ "accountId": account_id }));
    st.sync_kick.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn event_create(app: AppHandle, st: St<'_>, draft: EventDraft) -> R<CalEvent> {
    if draft.subject.trim().is_empty() {
        return Err("Give the event a title".into());
    }
    if draft.end <= draft.start {
        return Err("The event must end after it starts".into());
    }
    let ev = graph::create_event(&st, &calendar::local_tz(), &draft).await.map_err(|e| format!("{e:#}"))?;
    st.db.upsert_event(&ev).map_err(err)?;
    let _ = app.emit("calendar://changed", json!({ "accountId": draft.account_id }));
    Ok(ev)
}

#[tauri::command]
pub async fn calendar_free_slots(st: St<'_>, query: FreeSlotQuery) -> R<Vec<FreeSlot>> {
    calendar::free_slots(&st, &query).await.map_err(|e| format!("{e:#}"))
}
