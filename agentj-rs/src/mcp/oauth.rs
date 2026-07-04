//! Native MCP OAuth for `type: http` servers: RFC 8414 metadata discovery, dynamic client
//! registration, and the PKCE authorization-code flow (all via rmcp's auth stack), with tokens
//! cached on disk so a server is authorized ONCE per machine and connects silently ever after.
//!
//! Authorization is deliberate, never ambient: startup NEVER opens a browser. An unauthorized
//! server surfaces as "needs authorization — /mcp login <name>", and the browser flow runs only
//! when the user invokes it.

use rmcp::transport::auth::{
    AuthClient, AuthError, AuthorizationManager, CredentialStore, StoredCredentials,
};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

/// Where a server's credentials live: `~/.agentj/mcp-auth/<hash>.json` (0600). Keyed by URL, so the
/// same server shared across repos/worktrees uses one grant.
fn cache_path(url: &str) -> PathBuf {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".agentj")
        .join("mcp-auth")
        .join(format!("{:016x}.json", h.finish()))
}

/// Disk-backed credential store (rmcp persists through this on token exchange/refresh).
struct DiskCredentialStore {
    path: PathBuf,
}

#[async_trait::async_trait]
impl CredentialStore for DiskCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(serde_json::from_str(&s).ok()),
            Err(_) => Ok(None),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let body = serde_json::to_string(&credentials)
            .map_err(|e| AuthError::InternalError(e.to_string()))?;
        std::fs::write(&self.path, body).map_err(|e| AuthError::InternalError(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        let _ = std::fs::remove_file(&self.path);
        Ok(())
    }
}

/// Whether this machine holds cached credentials for `url` (cheap file check — used to decide the
/// connect strategy without network calls).
pub fn has_cached_credentials(url: &str) -> bool {
    std::fs::read_to_string(cache_path(url))
        .ok()
        .and_then(|s| serde_json::from_str::<StoredCredentials>(&s).ok())
        .is_some_and(|c| c.token_response.is_some())
}

/// Build an authenticated HTTP client from the disk cache (silent — no browser). `None` when the
/// server has no cached grant or its auth metadata can't be discovered.
pub async fn cached_auth_client(url: &str) -> Option<AuthClient<reqwest::Client>> {
    let mut mgr = AuthorizationManager::new(url).await.ok()?;
    mgr.set_credential_store(DiskCredentialStore { path: cache_path(url) });
    match mgr.initialize_from_store().await {
        Ok(true) => Some(AuthClient::new(reqwest::Client::default(), mgr)),
        _ => None,
    }
}

/// Drop a server's cached grant (`/mcp logout`).
pub fn forget(url: &str) {
    let _ = std::fs::remove_file(cache_path(url));
}

/// Run the interactive authorization flow for `url`: discover metadata, register a client, open the
/// user's browser, catch the redirect on a loopback listener, exchange the code (rmcp persists the
/// tokens through the disk store). `notice` receives progress lines for the UI.
pub async fn login(url: &str, notice: impl Fn(String)) -> anyhow::Result<()> {
    let mut mgr = AuthorizationManager::new(url)
        .await
        .map_err(|e| anyhow::anyhow!("auth setup failed: {e}"))?;
    mgr.set_credential_store(DiskCredentialStore { path: cache_path(url) });
    let metadata = mgr
        .discover_metadata()
        .await
        .map_err(|e| anyhow::anyhow!("this server doesn't advertise OAuth metadata: {e}"))?;
    mgr.set_metadata(metadata);

    // Loopback redirect target on an ephemeral port — no fixed ports, no collisions.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr()?.port());

    mgr.register_client("agentj", &redirect, &[])
        .await
        .map_err(|e| anyhow::anyhow!("client registration failed: {e}"))?;
    let auth_url = mgr
        .get_authorization_url(&[])
        .await
        .map_err(|e| anyhow::anyhow!("couldn't build the authorization URL: {e}"))?;

    if open_browser(&auth_url) {
        notice("browser opened — approve the authorization".to_string());
    } else {
        notice(format!("open this URL to authorize: {auth_url}"));
    }

    let (code, state) = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        accept_callback(listener),
    )
    .await
    .map_err(|_| anyhow::anyhow!("authorization timed out (5m) — no callback received"))??;

    mgr.exchange_code_for_token(&code, &state)
        .await
        .map_err(|e| anyhow::anyhow!("token exchange failed: {e}"))?;
    notice("authorized — credentials cached for this machine".to_string());
    Ok(())
}

/// Accept ONE redirect on the loopback listener and pull `code` + `state` from its query string.
async fn accept_callback(listener: tokio::net::TcpListener) -> anyhow::Result<(String, String)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        // "GET /callback?code=..&state=.. HTTP/1.1"
        let path = req.split_whitespace().nth(1).unwrap_or_default();
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or_default();
        let get = |k: &str| {
            query.split('&').find_map(|kv| {
                kv.split_once('=')
                    .filter(|(key, _)| *key == k)
                    .map(|(_, v)| urldecode(v))
            })
        };
        let (code, state) = (get("code"), get("state"));
        let body = if code.is_some() {
            "<html><body style=\"font-family:sans-serif\"><h3>agentj: authorized \u{2713}</h3>You can close this tab.</body></html>"
        } else {
            "<html><body style=\"font-family:sans-serif\"><h3>agentj: missing code</h3></body></html>"
        };
        let _ = sock
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
        if let (Some(c), Some(s)) = (code, state) {
            return Ok((c, s));
        }
        // e.g. a favicon probe — keep listening for the real redirect.
    }
}

/// Minimal percent-decoding for OAuth query values.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn open_browser(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(target_os = "macos"))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urldecode_handles_percent_and_plus() {
        assert_eq!(urldecode("a%2Fb+c"), "a/b c");
        assert_eq!(urldecode("plain"), "plain");
        assert_eq!(urldecode("bad%2"), "bad%2");
    }

    #[test]
    fn cache_path_is_stable_and_per_url() {
        let a = cache_path("https://mcp.linear.app/mcp");
        let b = cache_path("https://mcp.linear.app/mcp");
        let c = cache_path("https://mcp.atlassian.com/v1/mcp");
        assert_eq!(a, b, "same url → same file");
        assert_ne!(a, c, "different url → different file");
        assert!(a.to_string_lossy().contains(".agentj/mcp-auth/"));
    }

    #[tokio::test]
    async fn callback_listener_extracts_code_and_state() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
            s.write_all(b"GET /callback?code=abc%2F1&state=xyz HTTP/1.1\r\nHost: x\r\n\r\n")
                .await
                .unwrap();
        });
        let (code, state) = accept_callback(listener).await.unwrap();
        client.await.unwrap();
        assert_eq!(code, "abc/1");
        assert_eq!(state, "xyz");
    }
}
