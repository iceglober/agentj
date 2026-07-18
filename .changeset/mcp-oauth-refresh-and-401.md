---
"@glrs-dev/aj": patch
---

Fix MCP OAuth background token refresh: the SDK read the token-only provider's missing redirect URL as a non-interactive grant and skipped the refresh path, so expired tokens forced a manual re-auth. Also classify the SDK's numeric 401/403 error codes (whose messages omit the status) so a never-authorized HTTP server points at `/mcp auth` instead of a generic connection failure, cancel the authorization wait immediately when its signal is already aborted, and document non-interactive (`agentj run`) behavior and the fallback for servers without dynamic client registration.
