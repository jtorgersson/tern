//! Microsoft identity platform: auth-code + PKCE with a loopback redirect (RFC 8252),
//! refresh tokens in the keyring, access tokens cached in memory.
use crate::secrets;
use crate::state::AppState;
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub const SCOPES: &str = "offline_access openid profile email User.Read Mail.ReadWrite Mail.Send MailboxSettings.Read Calendars.ReadWrite";
/// Asked for only once the user adds a shared mailbox or calendar, so tenants that need admin approval
/// for these never block a normal sign-in.
pub const SHARED_SCOPES: &str = "Mail.ReadWrite.Shared Mail.Send.Shared Calendars.ReadWrite.Shared";

pub const CONNECT_SCOPES: &str = "Chat.Read ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send";

pub const CONNECT_COMPOSE_SCOPES: &str = "Chat.Create User.ReadBasic.All";

fn scopes(shared: bool, connect: bool, compose: bool) -> String {
    let mut result = SCOPES.to_string();
    if shared { result.push_str(&format!(" {SHARED_SCOPES}")); }
    if connect { result.push_str(&format!(" {CONNECT_SCOPES}")); }
    if connect && compose { result.push_str(&format!(" {CONNECT_COMPOSE_SCOPES}")); }
    result
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("sign-in expired — please sign in to {0} again")]
    Reauth(String),
}

pub struct SignIn {
    pub access_token: String,
    pub refresh_token: String,
    pub tenant_id: Option<String>,
}

fn random_b64(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn token_url(tenant: &str) -> String {
    format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token")
}

const DONE_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Tern</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#10171e;color:#f7f6f2;
font:16px/1.5 system-ui,sans-serif}div{text-align:center}h1{font-weight:500;letter-spacing:-.02em;margin:0 0 .3em}
p{color:#8f9699;margin:0}</style></head><body><div><h1>%TITLE%</h1><p>%BODY%</p></div></body></html>"#;

async fn respond(stream: &mut tokio::net::TcpStream, ok: bool, msg: &str) {
    let (title, body) = if ok { ("You're signed in", "You can close this tab and return to Tern.") } else { ("Sign-in failed", msg) };
    let html = DONE_PAGE.replace("%TITLE%", title).replace("%BODY%", &html_escape(body));
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Waits for the browser redirect on the loopback listener; returns (code, state).
async fn wait_for_code(listener: TcpListener) -> Result<(String, String)> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let Some(path) = req.lines().next().and_then(|l| l.split_whitespace().nth(1)) else { continue };
        let Ok(url) = url::Url::parse(&format!("http://localhost{path}")) else { continue };
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        if let Some(err) = q.get("error") {
            let desc = q.get("error_description").cloned().unwrap_or_default();
            respond(&mut stream, false, &desc).await;
            bail!("{err}: {desc}");
        }
        match (q.get("code"), q.get("state")) {
            (Some(code), Some(state)) => {
                respond(&mut stream, true, "").await;
                return Ok((code.clone(), state.clone()));
            }
            // favicon.ico and friends
            _ => {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            }
        }
    }
}

/// Interactive sign-in in the system browser. `shared` also asks for the shared-mailbox scopes;
/// `login_hint` preselects the account (used when re-consenting an existing one).
#[allow(clippy::too_many_arguments)]
pub async fn interactive(
    http: &reqwest::Client,
    client_id: &str,
    tenant: &str,
    shared: bool,
    connect: bool,
    compose: bool,
    login_hint: Option<&str>,
    cancel: oneshot::Receiver<()>,
    on_waiting: impl FnOnce(),
    on_exchanging: impl FnOnce(),
) -> Result<SignIn> {
    if client_id.is_empty() {
        bail!("No Microsoft client ID configured. Add it in Settings → Accounts.");
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://localhost:{port}");
    let verifier = random_b64(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);
    let scope = scopes(shared, connect, compose);

    let mut auth = url::Url::parse(&format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"))?;
    auth.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_mode", "query")
        .append_pair("scope", &scope)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    match login_hint {
        Some(h) => auth.query_pairs_mut().append_pair("login_hint", h),
        None => auth.query_pairs_mut().append_pair("prompt", "select_account"),
    };

    tauri_plugin_opener::open_url(auth.as_str(), None::<&str>).context("could not open the browser")?;
    on_waiting();

    let (code, got_state) = tokio::select! {
        r = wait_for_code(listener) => r?,
        _ = cancel => bail!("Sign-in cancelled"),
        _ = tokio::time::sleep(Duration::from_secs(600)) => bail!("Sign-in timed out"),
    };
    if got_state != state {
        bail!("Sign-in state mismatch — please try again");
    }
    on_exchanging();

    let resp = http
        .post(token_url(tenant))
        .form(&[
            ("client_id", client_id),
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("code_verifier", &verifier),
            ("scope", &scope),
        ])
        .send()
        .await?;
    let tok = parse_token(resp).await?;
    let refresh_token = tok.refresh_token.ok_or_else(|| anyhow!("no refresh token returned (is offline_access allowed?)"))?;
    let tenant_id = tok.id_token.as_deref().and_then(jwt_claim_tid);
    Ok(SignIn { access_token: tok.access_token, refresh_token, tenant_id })
}

async fn parse_token(resp: reqwest::Response) -> Result<TokenResponse> {
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        if let Ok(e) = serde_json::from_str::<TokenError>(&text) {
            bail!("{}: {}", e.error, e.error_description.unwrap_or_default().lines().next().unwrap_or(""));
        }
        bail!("token endpoint returned {status}");
    }
    Ok(serde_json::from_str(&text)?)
}

fn jwt_claim_tid(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("tid")?.as_str().map(String::from)
}

pub fn refresh_key(account_id: &str) -> String {
    format!("ms:{account_id}")
}

/// The signed-in account whose tokens open `account_id` (itself, or the owner of a shared mailbox).
pub fn token_account(st: &AppState, account_id: &str) -> String {
    st.db.account(account_id).ok().flatten().and_then(|a| a.owner_id).unwrap_or_else(|| account_id.to_string())
}

/// Returns a valid access token for the account, refreshing (and rotating the refresh token) as needed.
pub async fn access_token(st: &AppState, account_id: &str) -> Result<String> {
    let account_id = &token_account(st, account_id);
    if let Some((tok, exp)) = st.tokens.lock().unwrap().get(account_id).cloned() {
        if exp > Instant::now() + Duration::from_secs(120) {
            return Ok(tok);
        }
    }
    // Serialize refreshes per process so rotation can't race.
    let _guard = st.refresh_lock.lock().await;
    if let Some((tok, exp)) = st.tokens.lock().unwrap().get(account_id).cloned() {
        if exp > Instant::now() + Duration::from_secs(120) {
            return Ok(tok);
        }
    }
    let acc = st.db.account(account_id)?;
    let shared = acc.as_ref().is_some_and(|a| a.shared_consent);
    let connect = acc.as_ref().is_some_and(|a| a.connect_consent);
    let compose = acc.as_ref().is_some_and(|a| a.connect_compose_consent);
    let email = acc.map(|a| a.email).unwrap_or_else(|| account_id.to_string());
    let scope = scopes(shared, connect, compose);
    let refresh = secrets::get(&refresh_key(account_id))?.ok_or_else(|| AuthError::Reauth(email.clone()))?;
    let settings = st.settings.read().unwrap().clone();
    let client_id = crate::settings::ms_client_id(&settings);
    let tenant = crate::settings::ms_tenant(&settings);
    let resp = st
        .http
        .post(token_url(&tenant))
        .form(&[
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("scope", scope.as_str()),
        ])
        .send()
        .await?;
    let tok = match parse_token(resp).await {
        Ok(t) => t,
        Err(e) if e.to_string().starts_with("invalid_grant") || e.to_string().starts_with("interaction_required") => {
            return Err(AuthError::Reauth(email).into());
        }
        Err(e) => return Err(e),
    };
    if let Some(rt) = &tok.refresh_token {
        secrets::set(&refresh_key(account_id), rt)?;
    }
    let exp = Instant::now() + Duration::from_secs(tok.expires_in);
    st.tokens.lock().unwrap().insert(account_id.to_string(), (tok.access_token.clone(), exp));
    Ok(tok.access_token)
}

pub fn cache_token(st: &AppState, account_id: &str, token: &str) {
    st.tokens
        .lock()
        .unwrap()
        .insert(account_id.to_string(), (token.to_string(), Instant::now() + Duration::from_secs(3000)));
}

#[cfg(test)]
mod tests {
    #[test]
    fn optional_scopes_do_not_block_normal_mail_sign_in() {
        assert_eq!(super::scopes(false, false, false), super::SCOPES);
        assert!(!super::scopes(true, false, false).contains("Chat.Read"));
        let connect = super::scopes(false, true, false);
        assert!(connect.contains("Chat.Read") && !connect.contains("Mail.ReadWrite.Shared"));
        assert!(!connect.contains("Chat.Create"));
        assert!(super::scopes(false, true, true).contains("Chat.Create"));
        let both = super::scopes(true, true, true);
        assert!(both.contains("Chat.Read") && both.contains("Mail.ReadWrite.Shared"));
    }
}
