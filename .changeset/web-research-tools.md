---
"@glrs-dev/aj": minor
---

Agentj can now research the public web in any model mode without a model-provider web feature or API key: `web_search` finds current sources through the built-in anonymous search service, while `web_fetch` reads a specific public URL as text. For example, an agent can search for a library’s current release notes, then fetch its documentation page to verify an API detail; fetched content is marked untrusted and outbound web access can be allowed, asked, or denied with `permissions.web`.
