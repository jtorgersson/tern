//! Connect: delegated Teams chats and channels. Tokens remain in Rust.
use crate::{auth, graph, model::Account, secrets, settings, state::AppState};
use anyhow::{bail, Result};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type St<'a> = State<'a, Arc<AppState>>;
const PERSONAL_TENANT: &str = "9188040d-6c67-4c5b-b112-36a304b66dad";

fn account(st: &AppState, id: &str, consent: bool) -> Result<Account> {
    let a = st.db.account(id)?.ok_or_else(|| anyhow::anyhow!("Account was removed"))?;
    if a.owner_id.is_some() || a.provider != "microsoft" {
        bail!("Choose one of your own Microsoft work or school accounts");
    }
    if a.tenant_id.as_deref() == Some(PERSONAL_TENANT) {
        bail!("Microsoft provides Teams chat access for work or school accounts only");
    }
    if consent && !a.connect_consent { bail!("Enable Connect for this account first"); }
    Ok(a)
}

#[tauri::command]
pub async fn connect_enable(app: AppHandle, st: St<'_>, account_id: String) -> Result<Account, String> {
    let a = account(&st, &account_id, false).map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Some(prev) = st.auth_cancel.lock().unwrap().replace(tx) { let _ = prev.send(()); }
    let s = st.settings.read().unwrap().clone();
    let result = async {
        let sign_in = auth::interactive(
            &st.http, &settings::ms_client_id(&s), &settings::ms_tenant(&s),
            a.shared_consent, true, Some(&a.email), rx, || {}, || {},
        ).await?;
        let (uid, email, _) = graph::me(&st.http, &sign_in.access_token).await?;
        if format!("ms-{uid}") != a.id || sign_in.tenant_id != a.tenant_id {
            bail!("You signed in as {email} — choose {} in the same organization", a.email);
        }
        // Serialize with token rotation before installing the newly consented credentials.
        let _guard = st.refresh_lock.lock().await;
        account(&st, &a.id, false)?;
        secrets::set(&auth::refresh_key(&a.id), &sign_in.refresh_token)?;
        st.db.set_connect_consent(&a.id)?;
        auth::cache_token(&st, &a.id, &sign_in.access_token);
        let _ = app.emit("accounts://changed", ());
        account(&st, &a.id, true)
    }.await;
    st.auth_cancel.lock().unwrap().take();
    result.map_err(|e| format!("{e:#}"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Resource {
    Chats,
    Teams,
    Channels { #[serde(rename = "teamId")] team_id: String },
    Chat { #[serde(rename = "chatId")] chat_id: String },
    Channel { #[serde(rename = "teamId")] team_id: String, #[serde(rename = "channelId")] channel_id: String },
    Replies { #[serde(rename = "teamId")] team_id: String, #[serde(rename = "channelId")] channel_id: String, #[serde(rename = "messageId")] message_id: String },
}

fn segment(value: &str) -> Result<String> {
    if value.is_empty() || value == "." || value == ".." { bail!("Missing or invalid conversation ID"); }
    let mut u = url::Url::parse("https://graph.microsoft.com/")?;
    u.path_segments_mut().unwrap().push(value);
    Ok(u.path().trim_start_matches('/').to_string())
}

impl Resource {
    fn path(&self) -> Result<String> {
        Ok(match self {
            Self::Chats => "/chats".into(),
            Self::Teams => "/me/joinedTeams".into(),
            Self::Channels { team_id } => format!("/teams/{}/channels", segment(team_id)?),
            Self::Chat { chat_id } => format!("/chats/{}/messages", segment(chat_id)?),
            Self::Channel { team_id, channel_id } => format!("/teams/{}/channels/{}/messages", segment(team_id)?, segment(channel_id)?),
            Self::Replies { team_id, channel_id, message_id } => format!("/teams/{}/channels/{}/messages/{}/replies", segment(team_id)?, segment(channel_id)?, segment(message_id)?),
        })
    }
    fn query(&self) -> &'static str {
        match self {
            Self::Chats => "?$top=50&$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc",
            Self::Chat { .. } => "?$top=50&$orderby=createdDateTime desc",
            Self::Channel { .. } | Self::Replies { .. } => "?$top=50",
            _ => "",
        }
    }
    fn can_send(&self) -> bool {
        matches!(self, Self::Chat { .. } | Self::Channel { .. } | Self::Replies { .. })
    }
}

fn decoded_path(url: &url::Url) -> Option<Vec<Vec<u8>>> {
    url.path_segments().map(|parts| parts.map(|p| percent_encoding::percent_decode_str(p).collect()).collect())
}

/// Pagination must stay on the requested Graph resource; never forward a token to an arbitrary URL.
fn page_url(resource: &Resource, next: Option<&str>) -> Result<String> {
    let path = resource.path()?;
    let Some(next) = next else { return Ok(format!("{path}{}", resource.query())); };
    let u = url::Url::parse(next)?;
    let expected = url::Url::parse(&format!("https://graph.microsoft.com/v1.0{path}"))?;
    if u.scheme() != "https" || u.host_str() != Some("graph.microsoft.com")
        || u.port_or_known_default() != Some(443) || !u.username().is_empty()
        || u.password().is_some() || u.fragment().is_some() || decoded_path(&u) != decoded_path(&expected) {
        bail!("Invalid Microsoft Graph pagination link");
    }
    Ok(u.to_string())
}

fn friendly_error(e: anyhow::Error) -> String {
    if let Some(g) = e.downcast_ref::<graph::GraphError>() {
        if g.status == 403 {
            return format!("Microsoft denied access. Reconnect to grant Connect permissions; your organization may require administrator consent or a Teams license. {}", g.message);
        }
    }
    e.to_string()
}

#[tauri::command]
pub async fn connect_list(st: St<'_>, account_id: String, resource: Resource, next: Option<String>) -> Result<Value, String> {
    account(&st, &account_id, true).map_err(friendly_error)?;
    let url = page_url(&resource, next.as_deref()).map_err(friendly_error)?;
    graph::call(&st, &account_id, Method::GET, &url, None).await.map_err(friendly_error)
}

#[tauri::command]
pub async fn connect_send(st: St<'_>, account_id: String, resource: Resource, text: String) -> Result<Value, String> {
    account(&st, &account_id, true).map_err(friendly_error)?;
    if !resource.can_send() { return Err("Select a chat or channel first".into()); }
    let text = text.trim();
    if text.is_empty() || text.len() > 20_000 { return Err("Write a message of at most 20,000 bytes".into()); }
    let path = resource.path().map_err(friendly_error)?;
    let body = json!({ "body": { "contentType": "text", "content": text } });
    // A POST isn't safe to retry after an ambiguous server failure: it can duplicate a message.
    graph::call_once(&st, &account_id, &path, &body).await.map_err(friendly_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pagination_is_bound_to_graph_and_conversation() {
        let r = Resource::Chat { chat_id: "19:abc@thread.v2".into() };
        let url = format!("https://graph.microsoft.com/v1.0{}?$skiptoken=opaque", r.path().unwrap());
        assert!(page_url(&r, Some(&url)).is_ok());
        // Graph may escape ':' and '@' even though they are legal literal path characters.
        assert!(page_url(&r, Some(&url.replace("19:", "19%3A").replace("@thread", "%40thread"))).is_ok());
        for bad in [url.replace("https:", "http:"), url.replace("graph.microsoft.com", "evil.example"), url.replace("/messages", "/members"), url.replace("/v1.0/", "/beta/")] {
            assert!(page_url(&r, Some(&bad)).is_err());
        }
        assert!(segment("..").is_err());
        assert!(!segment("a/b?#").unwrap().contains('/'));
    }
}
