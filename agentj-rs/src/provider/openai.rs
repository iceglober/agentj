//! OpenAI-compatible chat client (Azure AI Foundry `/openai/v1`, custom gateways like Bifrost, local
//! servers). Non-streaming `/chat/completions` with tool calls.

use super::{AssistantTurn, ChatMessage, TokenUsage, ToolCall, ToolSpec};
use crate::model::ModelConfig;
use serde::Deserialize;
use serde_json::json;

pub struct OpenAiProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    model: String,
    api_version: Option<String>,
}

impl OpenAiProvider {
    pub fn new(cfg: &ModelConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            model: cfg.model_id.clone(),
            api_version: cfg.api_version.clone(),
        }
    }

    pub async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> anyhow::Result<AssistantTurn> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let tool_json: Vec<_> = tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } }))
            .collect();
        let mut body = json!({ "model": self.model, "messages": messages });
        if !tool_json.is_empty() {
            body["tools"] = json!(tool_json);
            body["tool_choice"] = json!("auto");
        }

        let mut req = self.client.post(&url).json(&body);
        if let Some(k) = &self.api_key {
            req = req.bearer_auth(k);
        }
        if let Some(v) = &self.api_version {
            req = req.query(&[("api-version", v.as_str())]);
        }

        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            let snippet: String = text
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect();
            anyhow::bail!("HTTP {}: {}", status.as_u16(), snippet);
        }
        let parsed: ChatResponse = serde_json::from_str(&text).map_err(|e| {
            anyhow::anyhow!(
                "could not parse response ({e}): {}",
                text.chars().take(200).collect::<String>()
            )
        })?;
        let usage = parsed.usage.map(Into::into);
        let choice = parsed
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("no choices in response"))?;
        Ok(AssistantTurn {
            content: choice.message.content,
            tool_calls: choice.message.tool_calls,
            finish_reason: choice.finish_reason.unwrap_or_default(),
            usage,
        })
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Deserialize)]
struct Choice {
    message: RespMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct RespMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCall>,
}

#[derive(Deserialize, Default)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    prompt_tokens_details: Option<WirePromptDetails>,
}

#[derive(Deserialize, Default)]
struct WirePromptDetails {
    #[serde(default)]
    cached_tokens: u64,
}

impl From<WireUsage> for TokenUsage {
    fn from(u: WireUsage) -> Self {
        TokenUsage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            cached_tokens: u.prompt_tokens_details.map(|d| d.cached_tokens),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: &str) -> AssistantTurn {
        let parsed: ChatResponse = serde_json::from_str(body).unwrap();
        let usage = parsed.usage.map(Into::into);
        let choice = parsed.choices.into_iter().next().unwrap();
        AssistantTurn {
            content: choice.message.content,
            tool_calls: choice.message.tool_calls,
            finish_reason: choice.finish_reason.unwrap_or_default(),
            usage,
        }
    }

    #[test]
    fn usage_deserializes_with_cached_details() {
        let turn = parse(
            r#"{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150,
                         "prompt_tokens_details":{"cached_tokens":64}}}"#,
        );
        let u = turn.usage.expect("usage present");
        assert_eq!(u.prompt_tokens, 120);
        assert_eq!(u.completion_tokens, 30);
        assert_eq!(u.total_tokens, 150);
        assert_eq!(u.cached_tokens, Some(64));
    }

    #[test]
    fn usage_without_details_or_absent() {
        let turn = parse(
            r#"{"choices":[{"message":{"content":"hi"}}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#,
        );
        let u = turn.usage.unwrap();
        assert_eq!(u.cached_tokens, None);
        assert_eq!(u.total_tokens, 15);

        let none = parse(r#"{"choices":[{"message":{"content":"hi"}}]}"#);
        assert!(none.usage.is_none());
    }
}
