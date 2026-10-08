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
            a.shared_consent, true, true, Some(&a.email), rx, || {}, || {},
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
    Members { #[serde(rename = "chatId")] chat_id: String },
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
            Self::Members { chat_id } => format!("/chats/{}/members", segment(chat_id)?),
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

fn compose_account(st: &AppState, id: &str) -> Result<Account> {
    let a = account(st, id, true)?;
    if !a.connect_compose_consent { bail!("Reconnect Connect to allow finding people and creating conversations"); }
    Ok(a)
}

fn people_path(query: &str) -> Result<String> {
    let q = query.trim();
    if q.chars().count() < 2 || q.len() > 200 { bail!("Enter 2–200 characters of a name or email address"); }
    let literal = q.replace('\'', "''");
    let filter = format!("startswith(displayName,'{literal}') or startswith(mail,'{literal}') or startswith(userPrincipalName,'{literal}') or startswith(givenName,'{literal}') or startswith(surname,'{literal}')");
    let mut u = url::Url::parse("https://graph.microsoft.com/v1.0/users")?;
    u.query_pairs_mut().append_pair("$select", "id,displayName,mail,userPrincipalName,userType").append_pair("$top", "20").append_pair("$filter", &filter);
    Ok(u.to_string())
}

#[tauri::command]
pub async fn connect_people(st: St<'_>, account_id: String, query: String) -> Result<Value, String> {
    compose_account(&st, &account_id).map_err(friendly_error)?;
    let path = people_path(&query).map_err(friendly_error)?;
    graph::call(&st, &account_id, Method::GET, &path, None).await.map_err(friendly_error)
}

fn chat_body(me: &str, people: &[Value], topic: &str) -> Result<Value> {
    let me = uuid::Uuid::parse_str(me)?.to_string();
    let mut ids = std::collections::HashSet::from([me.clone()]);
    let member = |id: &str, guest: bool| json!({
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        "roles": [if guest { "guest" } else { "owner" }],
        "user@odata.bind": format!("https://graph.microsoft.com/v1.0/users('{id}')")
    });
    let mut members = vec![member(&me, false)];
    for person in people {
        let id = uuid::Uuid::parse_str(person["id"].as_str().unwrap_or_default())?.to_string();
        if ids.insert(id.clone()) { members.push(member(&id, person["userType"].as_str() == Some("Guest"))); }
    }
    if members.len() < 2 || members.len() > 21 { bail!("Choose between 1 and 20 other people"); }
    if topic.chars().count() > 250 { bail!("Use a conversation name of at most 250 characters"); }
    let group = members.len() > 2;
    let mut body = json!({ "chatType": if group { "group" } else { "oneOnOne" }, "members": members });
    if group && !topic.trim().is_empty() { body["topic"] = json!(topic.trim()); }
    Ok(body)
}

#[tauri::command]
pub async fn connect_create_chat(st: St<'_>, account_id: String, user_ids: Vec<String>, topic: String) -> Result<Value, String> {
    let a = compose_account(&st, &account_id).map_err(friendly_error)?;
    if user_ids.is_empty() || user_ids.len() > 20 { return Err("Choose between 1 and 20 people".into()); }
    let result = async {
        let mut people = Vec::new();
        // Resolve each selected identity server-side; names/emails from the UI aren't trusted IDs.
        for id in user_ids {
            let id = uuid::Uuid::parse_str(&id)?;
            people.push(graph::call(&st, &account_id, Method::GET, &format!("/users/{id}?$select=id,displayName,mail,userPrincipalName,userType"), None).await?);
        }
        let body = chat_body(a.id.strip_prefix("ms-").unwrap_or_default(), &people, &topic)?;
        // Creation may notify participants. Never retry an ambiguous POST automatically.
        let mut chat = graph::call_once(&st, &account_id, "/chats", &body).await?;
        if chat["id"].as_str().is_none() { bail!("Microsoft returned no conversation ID; check your chats before retrying"); }
        chat["members"] = json!(people.iter().map(|p| json!({ "userId": p["id"], "displayName": p["displayName"], "email": p["mail"].as_str().or(p["userPrincipalName"].as_str()) })).collect::<Vec<_>>());
        anyhow::Ok(chat)
    }.await;
    result.map_err(friendly_error)
}

#[tauri::command]
pub async fn connect_search(st: St<'_>, account_id: String, query: String, from: u32) -> Result<Value, String> {
    account(&st, &account_id, true).map_err(friendly_error)?;
    if query.trim().is_empty() || query.len() > 1000 || from > 1000 { return Err("Use a query up to 1,000 characters and refine searches beyond 1,000 results".into()); }
    let body = json!({ "requests": [{ "entityTypes": ["chatMessage"], "query": { "queryString": query.trim() }, "from": from, "size": 25, "enableTopResults": true }] });
    graph::call(&st, &account_id, Method::POST, "/search/query", Some(&body)).await.map_err(friendly_error)
}

#[tauri::command]
pub async fn connect_message(st: St<'_>, account_id: String, resource: Resource, message_id: String) -> Result<Value, String> {
    account(&st, &account_id, true).map_err(friendly_error)?;
    if !resource.can_send() { return Err("Select a conversation".into()); }
    let path = format!("{}/{}", resource.path().map_err(friendly_error)?, segment(&message_id).map_err(friendly_error)?);
    graph::call(&st, &account_id, Method::GET, &path, None).await.map_err(friendly_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_direct_or_group_with_validated_members() {
        let me = "00000000-0000-0000-0000-000000000001";
        let other = json!({"id": "00000000-0000-0000-0000-000000000002", "userType": "Member"});
        let guest = json!({"id": "00000000-0000-0000-0000-000000000003", "userType": "Guest"});
        let direct = chat_body(me, &[other.clone(), other.clone()], "ignored").unwrap();
        assert_eq!(direct["chatType"], "oneOnOne");
        assert_eq!(direct["members"].as_array().unwrap().len(), 2);
        assert!(direct.get("topic").is_none());
        let group = chat_body(me, &[other, guest], " Launch ").unwrap();
        assert_eq!(group["chatType"], "group");
        assert_eq!(group["topic"], "Launch");
        assert_eq!(group["members"][2]["roles"][0], "guest");
        assert!(chat_body(me, &[json!({"id": me})], "").is_err());
        assert!(chat_body(me, &[json!({"id": "bad')/messages"})], "").is_err());
    }

    #[test]
    fn directory_query_escapes_odata_literals_and_bounds_input() {
        let path = people_path("O'Brien & Sons").unwrap();
        let url = url::Url::parse(&path).unwrap();
        assert_eq!(url.host_str(), Some("graph.microsoft.com"));
        let filter = url.query_pairs().find(|(k, _)| k == "$filter").unwrap().1.into_owned();
        assert!(filter.contains("'O''Brien & Sons'"));
        assert_eq!(url.query_pairs().count(), 3);
        assert!(people_path("a").is_err());
        assert!(people_path(&"a".repeat(201)).is_err());
    }

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
