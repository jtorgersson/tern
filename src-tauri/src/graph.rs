//! Minimal Microsoft Graph mail client.
use crate::auth;
use crate::db::{IncomingMessage, StoredBody};
use crate::model::*;
use crate::state::AppState;
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use regex::Regex;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::Duration;

const BASE: &str = "https://graph.microsoft.com/v1.0";
const MSG_SELECT: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,bodyPreview,receivedDateTime,\
isRead,flag,hasAttachments,importance,webLink,parentFolderId,isDraft";
pub const WELL_KNOWN: [&str; 7] = ["inbox", "drafts", "sentitems", "archive", "deleteditems", "junkemail", "outbox"];
/// How far back the first sync of a folder reaches.
pub const INITIAL_WINDOW_DAYS: i64 = 120;

#[derive(Debug, thiserror::Error)]
#[error("Graph {status}: {message}")]
pub struct GraphError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

async fn send_raw(
    st: &AppState,
    account_id: &str,
    method: Method,
    url: &str,
    body: Option<&Value>,
    extra_prefer: Option<&str>,
) -> Result<reqwest::Response> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let token = auth::access_token(st, account_id).await?;
        let full = if url.starts_with("https://") { url.to_string() } else { format!("{BASE}{url}") };
        let mut prefer = String::from("IdType=\"ImmutableId\"");
        if let Some(p) = extra_prefer {
            prefer.push_str(", ");
            prefer.push_str(p);
        }
        let mut req = st.http.request(method.clone(), &full).bearer_auth(&token).header("Prefer", prefer);
        match body {
            Some(b) => req = req.json(b),
            // Graph answers 411 to a body-less POST/PATCH (e.g. `/send`) unless Content-Length: 0 is sent.
            None if matches!(method, Method::POST | Method::PATCH | Method::PUT) => req = req.body(""),
            None => {}
        }
        let resp = req.send().await?;
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED && attempt == 1 {
            st.tokens.lock().unwrap().remove(account_id);
            continue;
        }
        if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempt <= 3 {
            let wait = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(2u64.pow(attempt));
            tokio::time::sleep(Duration::from_secs(wait.min(30))).await;
            continue;
        }
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            return Err(GraphError {
                status: status.as_u16(),
                code: v.pointer("/error/code").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                message: v.pointer("/error/message").and_then(|c| c.as_str()).unwrap_or(&text).to_string(),
            }
            .into());
        }
        return Ok(resp);
    }
}

async fn call(st: &AppState, account_id: &str, method: Method, url: &str, body: Option<&Value>) -> Result<Value> {
    let resp = send_raw(st, account_id, method, url, body, None).await?;
    let text = resp.text().await?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text)?)
}

/// Used during sign-in, before the account exists.
pub async fn me(http: &reqwest::Client, token: &str) -> Result<(String, String, String)> {
    let v: Value = http
        .get(format!("{BASE}/me?$select=id,displayName,mail,userPrincipalName"))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let id = v["id"].as_str().ok_or_else(|| anyhow!("Graph /me returned no id"))?.to_string();
    let email = v["mail"].as_str().filter(|s| !s.is_empty()).or(v["userPrincipalName"].as_str()).unwrap_or("").to_string();
    let name = v["displayName"].as_str().unwrap_or(&email).to_string();
    Ok((id, email, name))
}

fn addr(v: &Value) -> Addr {
    Addr {
        name: v.pointer("/emailAddress/name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        email: v.pointer("/emailAddress/address").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    }
}

fn addrs(v: &Value) -> Vec<Addr> {
    v.as_array().map(|a| a.iter().map(addr).collect()).unwrap_or_default()
}

pub fn recipients(list: &[Addr]) -> Value {
    Value::Array(
        list.iter()
            .map(|a| json!({ "emailAddress": { "address": a.email, "name": if a.name.is_empty() { &a.email } else { &a.name } } }))
            .collect(),
    )
}

fn to_incoming(account_id: &str, folder_id: &str, v: &Value) -> IncomingMessage {
    IncomingMessage {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        account_id: account_id.to_string(),
        folder_id: v["parentFolderId"].as_str().unwrap_or(folder_id).to_string(),
        conversation_id: v["conversationId"].as_str().unwrap_or("").to_string(),
        subject: v["subject"].as_str().unwrap_or("").to_string(),
        from: if v["from"].is_object() { addr(&v["from"]) } else { Addr::default() },
        to: addrs(&v["toRecipients"]),
        cc: addrs(&v["ccRecipients"]),
        preview: v["bodyPreview"].as_str().unwrap_or("").to_string(),
        received_at: v["receivedDateTime"].as_str().unwrap_or("1970-01-01T00:00:00Z").to_string(),
        is_read: v["isRead"].as_bool().unwrap_or(true),
        is_flagged: v.pointer("/flag/flagStatus").and_then(|f| f.as_str()) == Some("flagged"),
        has_attachments: v["hasAttachments"].as_bool().unwrap_or(false),
        importance: v["importance"].as_str().unwrap_or("normal").to_string(),
        web_link: v["webLink"].as_str().map(String::from),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
    }
}

// ---------------- folders ----------------

pub async fn folders(st: &AppState, account_id: &str) -> Result<Vec<Folder>> {
    let sel = "$select=id,displayName,parentFolderId,unreadItemCount,totalItemCount,childFolderCount&$top=250";
    let mut out = Vec::new();
    let mut queue = vec![format!("/me/mailFolders?{sel}")];
    while let Some(url) = queue.pop() {
        let mut next = Some(url);
        while let Some(u) = next.take() {
            let v = call(st, account_id, Method::GET, &u, None).await?;
            for f in v["value"].as_array().cloned().unwrap_or_default() {
                let id = f["id"].as_str().unwrap_or_default().to_string();
                if f["childFolderCount"].as_i64().unwrap_or(0) > 0 {
                    queue.push(format!("/me/mailFolders/{id}/childFolders?{sel}"));
                }
                out.push(Folder {
                    id,
                    account_id: account_id.to_string(),
                    name: f["displayName"].as_str().unwrap_or("").to_string(),
                    well_known: None,
                    parent_id: f["parentFolderId"].as_str().map(String::from),
                    unread: f["unreadItemCount"].as_i64().unwrap_or(0),
                    total: f["totalItemCount"].as_i64().unwrap_or(0),
                });
            }
            next = v["@odata.nextLink"].as_str().map(String::from);
        }
    }
    // Resolve well-known folder ids in one $batch round-trip.
    let reqs: Vec<Value> = WELL_KNOWN
        .iter()
        .enumerate()
        .map(|(i, wk)| json!({ "id": i.to_string(), "method": "GET", "url": format!("/me/mailFolders/{wk}?$select=id") }))
        .collect();
    let batch = call(st, account_id, Method::POST, "/$batch", Some(&json!({ "requests": reqs }))).await?;
    for r in batch["responses"].as_array().cloned().unwrap_or_default() {
        let idx: usize = r["id"].as_str().and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
        if let (Some(wk), Some(fid)) = (WELL_KNOWN.get(idx), r.pointer("/body/id").and_then(|x| x.as_str())) {
            if let Some(f) = out.iter_mut().find(|f| f.id == fid) {
                f.well_known = Some(wk.to_string());
            }
        }
    }
    // Top-level folders: parent is the hidden msgfolderroot — normalise to None.
    let ids: std::collections::HashSet<String> = out.iter().map(|f| f.id.clone()).collect();
    for f in out.iter_mut() {
        if f.parent_id.as_ref().is_some_and(|p| !ids.contains(p)) {
            f.parent_id = None;
        }
    }
    Ok(out)
}

// ---------------- delta sync ----------------

pub struct DeltaPage {
    pub items: Vec<IncomingMessage>,
    pub removed: Vec<String>,
    pub next_link: Option<String>,
    pub delta_link: Option<String>,
}

pub fn initial_delta_url(folder_id: &str) -> String {
    let since = (chrono::Utc::now() - chrono::Duration::days(INITIAL_WINDOW_DAYS)).format("%Y-%m-%dT%H:%M:%SZ");
    format!(
        "/me/mailFolders/{folder_id}/messages/delta?$select={MSG_SELECT}&$filter=receivedDateTime+ge+{since}&$orderby=receivedDateTime+desc"
    )
}

pub async fn delta_page(st: &AppState, account_id: &str, folder_id: &str, url: &str) -> Result<DeltaPage> {
    let resp = send_raw(st, account_id, Method::GET, url, None, Some("odata.maxpagesize=100")).await?;
    let v: Value = resp.json().await?;
    let mut items = Vec::new();
    let mut removed = Vec::new();
    for m in v["value"].as_array().cloned().unwrap_or_default() {
        if m.get("@removed").is_some() {
            if let Some(id) = m["id"].as_str() {
                removed.push(id.to_string());
            }
        } else if m.get("receivedDateTime").is_some() {
            items.push(to_incoming(account_id, folder_id, &m));
        }
    }
    Ok(DeltaPage {
        items,
        removed,
        next_link: v["@odata.nextLink"].as_str().map(String::from),
        delta_link: v["@odata.deltaLink"].as_str().map(String::from),
    })
}

// ---------------- bodies ----------------

static RE_DROP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<(head|style|script|title)[^>]*>.*?</\s*(head|style|script|title)\s*>").unwrap());
static RE_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>|</(p|div|tr|li|h[1-6]|blockquote)\s*>").unwrap());
static RE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static RE_BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[ \t\u{a0}]*\n([ \t\u{a0}]*\n)+").unwrap());
static RE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\u{a0}]{2,}").unwrap());

pub fn html_to_text(html: &str) -> String {
    let s = RE_DROP.replace_all(html, "");
    let s = RE_BREAK.replace_all(&s, "\n");
    let s = RE_TAG.replace_all(&s, "");
    let s = s
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&rsquo;", "’")
        .replace("&amp;", "&");
    let s = RE_SPACES.replace_all(&s, " ");
    RE_BLANK.replace_all(s.trim(), "\n\n").to_string()
}

pub async fn body(st: &AppState, account_id: &str, id: &str) -> Result<StoredBody> {
    let url = format!("/me/messages/{id}?$select=body,bccRecipients,replyTo,hasAttachments");
    let resp = send_raw(st, account_id, Method::GET, &url, None, Some("outlook.body-content-type=\"html\"")).await?;
    let v: Value = resp.json().await?;
    let mut html = v.pointer("/body/content").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if v.pointer("/body/contentType").and_then(|x| x.as_str()) == Some("text") {
        html = format!("<pre style=\"white-space:pre-wrap;font:inherit\">{}</pre>", html.replace('&', "&amp;").replace('<', "&lt;"));
    }
    let mut attachments = Vec::new();
    if v["hasAttachments"].as_bool().unwrap_or(false) || html.contains("cid:") {
        let a = call(
            st,
            account_id,
            Method::GET,
            &format!("/me/messages/{id}/attachments?$select=id,name,size,contentType,isInline"),
            None,
        )
        .await?;
        for x in a["value"].as_array().cloned().unwrap_or_default() {
            attachments.push(Attachment {
                id: x["id"].as_str().unwrap_or_default().to_string(),
                name: x["name"].as_str().unwrap_or("attachment").to_string(),
                size: x["size"].as_i64().unwrap_or(0),
                content_type: x["contentType"].as_str().unwrap_or("application/octet-stream").to_string(),
                is_inline: x["isInline"].as_bool().unwrap_or(false),
                content_id: None,
            });
        }
        // Inline images: rewrite cid: references to data: URIs (bounded).
        if html.contains("cid:") {
            let mut budget: i64 = 12 * 1024 * 1024;
            for att in attachments.iter_mut().filter(|a| a.content_type.starts_with("image/")) {
                if att.size > budget {
                    continue;
                }
                let full = call(st, account_id, Method::GET, &format!("/me/messages/{id}/attachments/{}", att.id), None).await?;
                let (Some(cid), Some(bytes)) = (full["contentId"].as_str(), full["contentBytes"].as_str()) else { continue };
                let cid = cid.trim_matches(|c| c == '<' || c == '>').to_string();
                let data = format!("data:{};base64,{}", att.content_type, bytes);
                if html.contains(&format!("cid:{cid}")) {
                    html = html.replace(&format!("cid:{cid}"), &data);
                    att.is_inline = true;
                }
                att.content_id = Some(cid);
                budget -= att.size;
            }
        }
    }
    Ok(StoredBody {
        text: html_to_text(&html),
        html,
        bcc: addrs(&v["bccRecipients"]),
        reply_to: addrs(&v["replyTo"]),
        attachments,
    })
}

pub async fn attachment_bytes(st: &AppState, account_id: &str, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
    let v = call(st, account_id, Method::GET, &format!("/me/messages/{message_id}/attachments/{attachment_id}"), None).await?;
    match v["contentBytes"].as_str() {
        Some(b) => Ok(base64::engine::general_purpose::STANDARD.decode(b)?),
        None => {
            // Item / reference attachments have no bytes; fetch the raw MIME value instead.
            let resp = send_raw(
                st,
                account_id,
                Method::GET,
                &format!("/me/messages/{message_id}/attachments/{attachment_id}/$value"),
                None,
                None,
            )
            .await?;
            Ok(resp.bytes().await?.to_vec())
        }
    }
}

// ---------------- actions ----------------

pub async fn patch(st: &AppState, account_id: &str, id: &str, body: Value) -> Result<()> {
    call(st, account_id, Method::PATCH, &format!("/me/messages/{id}"), Some(&body)).await?;
    Ok(())
}

pub async fn move_to(st: &AppState, account_id: &str, id: &str, destination: &str) -> Result<String> {
    let v = call(st, account_id, Method::POST, &format!("/me/messages/{id}/move"), Some(&json!({ "destinationId": destination }))).await?;
    Ok(v["id"].as_str().unwrap_or(id).to_string())
}

pub async fn delete(st: &AppState, account_id: &str, id: &str) -> Result<()> {
    call(st, account_id, Method::DELETE, &format!("/me/messages/{id}"), None).await?;
    Ok(())
}

pub async fn send_new(st: &AppState, m: &OutgoingMessage) -> Result<()> {
    let body = json!({
        "message": {
            "subject": m.subject,
            "body": { "contentType": "HTML", "content": m.body_html },
            "toRecipients": recipients(&m.to),
            "ccRecipients": recipients(&m.cc),
            "bccRecipients": recipients(&m.bcc),
        },
        "saveToSentItems": true
    });
    call(st, &m.account_id, Method::POST, "/me/sendMail", Some(&body)).await?;
    Ok(())
}

/// Reply / reply-all / forward: create the draft server-side (keeps threading headers and
/// the quoted original), put our text on top, set recipients, then send it.
pub async fn send_response(st: &AppState, m: &OutgoingMessage) -> Result<()> {
    let ref_id = m.ref_message_id.as_deref().ok_or_else(|| anyhow!("missing refMessageId"))?;
    let action = match m.mode.as_str() {
        "reply" => "createReply",
        "replyAll" => "createReplyAll",
        "forward" => "createForward",
        other => bail!("unknown compose mode {other}"),
    };
    let draft = call(st, &m.account_id, Method::POST, &format!("/me/messages/{ref_id}/{action}"), Some(&json!({}))).await?;
    let draft_id = draft["id"].as_str().ok_or_else(|| anyhow!("Graph did not return a draft"))?.to_string();
    let quoted = draft.pointer("/body/content").and_then(|x| x.as_str()).unwrap_or("");
    let html = merge_into_quoted(&m.body_html, quoted);
    let mut patch_body = json!({
        "subject": m.subject,
        "body": { "contentType": "HTML", "content": html },
    });
    // Replies with no explicit recipients keep the ones Graph derived from the original.
    if !(m.to.is_empty() && m.cc.is_empty() && m.bcc.is_empty()) {
        patch_body["toRecipients"] = recipients(&m.to);
        patch_body["ccRecipients"] = recipients(&m.cc);
        patch_body["bccRecipients"] = recipients(&m.bcc);
    }
    if m.subject.trim().is_empty() {
        patch_body.as_object_mut().unwrap().remove("subject");
    }
    let result = async {
        call(st, &m.account_id, Method::PATCH, &format!("/me/messages/{draft_id}"), Some(&patch_body)).await?;
        call(st, &m.account_id, Method::POST, &format!("/me/messages/{draft_id}/send"), None).await?;
        anyhow::Ok(())
    }
    .await;
    if result.is_err() {
        let _ = delete(st, &m.account_id, &draft_id).await;
    }
    result
}

/// Inserts our HTML right after <body ...> of the server-generated draft (which holds the quote).
fn merge_into_quoted(ours: &str, quoted: &str) -> String {
    let lower = quoted.to_ascii_lowercase();
    if let Some(start) = lower.find("<body") {
        if let Some(end) = lower[start..].find('>') {
            let at = start + end + 1;
            return format!("{}<div>{}</div><br>{}", &quoted[..at], ours, &quoted[at..]);
        }
    }
    format!("<div>{ours}</div><br>{quoted}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn html_to_text_basic() {
        let t = super::html_to_text(
            "<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;John,</p><div>See <b>below</b> &amp; reply</div><br><br><br><p>Thanks</p></body></html>",
        );
        assert_eq!(t, "Hi John,\nSee below & reply\n\nThanks");
    }

    #[test]
    fn merge_reply() {
        let m = super::merge_into_quoted("<p>Yes</p>", "<html><body dir=\"ltr\"><hr>orig</body></html>");
        assert_eq!(m, "<html><body dir=\"ltr\"><div><p>Yes</p></div><br><hr>orig</body></html>");
    }
}
