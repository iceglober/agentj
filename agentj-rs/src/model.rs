//! Model/provider resolution. Port of `model.ts`. Stage 1 wires the OpenAI-compatible path (azure +
//! custom) end-to-end; vertex + anthropic are recognized and preflighted but their clients are staged.

use crate::config::{AppConfig, ProviderConfig};
use std::env;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Vertex,
    Anthropic,
    Azure,
    Custom,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Vertex => "vertex",
            Provider::Anthropic => "anthropic",
            Provider::Azure => "azure",
            Provider::Custom => "custom",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "vertex" => Some(Provider::Vertex),
            "anthropic" => Some(Provider::Anthropic),
            "azure" => Some(Provider::Azure),
            "custom" => Some(Provider::Custom),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectorOverride {
    pub model: Option<String>,
}

/// Resolve the active provider from a string (flag or `AGENTJ_PROVIDER`), then app config; default Vertex.
pub fn resolve_provider(value: Option<&str>, app: &AppConfig) -> Provider {
    match value
        .or(_env("AGENTJ_PROVIDER").as_deref())
        .or(app.provider.as_deref())
    {
        Some("anthropic") => Provider::Anthropic,
        Some("azure") => Provider::Azure,
        Some("custom") => Provider::Custom,
        _ => Provider::Vertex,
    }
}

fn _env(k: &str) -> Option<String> {
    env::var(k).ok().filter(|s| !s.is_empty())
}

fn provider_config<'a>(provider: Provider, app: &'a AppConfig) -> &'a ProviderConfig {
    match provider {
        Provider::Vertex => &app.providers.vertex,
        Provider::Anthropic => &app.providers.anthropic,
        Provider::Azure => &app.providers.azure,
        Provider::Custom => &app.providers.custom,
    }
}

fn default_model(p: Provider) -> Option<&'static str> {
    match p {
        Provider::Vertex => Some("gemini-2.5-pro"),
        Provider::Anthropic => Some("claude-opus-4-8"),
        Provider::Azure | Provider::Custom => None,
    }
}

fn resolved_model(sel: &Selector, app: &AppConfig) -> Option<String> {
    sel.model
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_MODEL"))
        .or_else(|| provider_config(sel.provider, app).model())
        .or_else(|| app.model.clone().filter(|s| !s.is_empty()))
}

/// Everything needed to talk to a model, resolved from flags + env.
#[derive(Debug, Clone)]
pub struct ModelConfig {
    pub provider: Provider,
    pub model_id: String,
    /// Base URL for azure/custom (OpenAI-compatible). Empty for vertex/anthropic.
    pub base_url: String,
    pub api_key: Option<String>,
    /// Azure api-version query param, if set.
    pub api_version: Option<String>,
}

pub struct Selector<'a> {
    pub provider: Provider,
    pub model: Option<&'a str>,
    pub base_url: Option<&'a str>,
}

fn custom_base_url(explicit: Option<&str>, app: &AppConfig) -> String {
    explicit
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_BASE_URL"))
        .or_else(|| provider_config(Provider::Custom, app).base_url())
        .or_else(|| app.base_url.clone().filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

fn azure_base_url(app: &AppConfig) -> String {
    _env("AZURE_BASE_URL")
        .or_else(|| provider_config(Provider::Azure, app).base_url())
        .unwrap_or_default()
}

fn azure_api_key(_app: &AppConfig) -> Option<String> {
    _env("AZURE_API_KEY")
}

fn azure_api_version(app: &AppConfig) -> Option<String> {
    _env("AZURE_API_VERSION").or_else(|| provider_config(Provider::Azure, app).api_version())
}

fn anthropic_api_key(_app: &AppConfig) -> Option<String> {
    _env("ANTHROPIC_API_KEY")
}

fn custom_api_key(_app: &AppConfig) -> Option<String> {
    _env("AGENTJ_API_KEY")
}

fn vertex_project(app: &AppConfig) -> Option<String> {
    _env("GOOGLE_VERTEX_PROJECT").or_else(|| provider_config(Provider::Vertex, app).project())
}

/// Check provider credentials/config before a run. `Ok(())` when ready; `Err(msg)` with an actionable
/// message otherwise. Mirrors `preflight` in model.ts.
pub fn preflight(sel: &Selector, app: &AppConfig) -> Result<(), String> {
    let model_id = resolved_model(sel, app);
    match sel.provider {
        Provider::Vertex => {
            if vertex_project(app).is_none() {
                return Err("Vertex provider needs GOOGLE_VERTEX_PROJECT set (or providers.vertex.project in aj.json) (auth via `gcloud auth application-default login`). [vertex client staged — stage 2]".into());
            }
            Ok(())
        }
        Provider::Anthropic => {
            if anthropic_api_key(app).is_none() {
                return Err("Anthropic provider needs ANTHROPIC_API_KEY set in the developer environment. [anthropic client staged — stage 2]".into());
            }
            Ok(())
        }
        Provider::Azure => {
            if azure_base_url(app).is_empty() {
                return Err("Azure provider needs AZURE_BASE_URL set (or providers.azure.base_url in aj.json) (your Foundry OpenAI-compatible endpoint, e.g. https://<resource>.openai.azure.com/openai/v1).".into());
            }
            if azure_api_key(app).is_none() {
                return Err("Azure provider needs AZURE_API_KEY set in the developer environment.".into());
            }
            if model_id.is_none() {
                return Err("Azure provider has no default model — set AGENTJ_MODEL, pass --model, or add providers.azure.model in aj.json (the Foundry deployment name).".into());
            }
            Ok(())
        }
        Provider::Custom => {
            if custom_base_url(sel.base_url, app).is_empty() {
                return Err("Custom provider needs a base URL — set AGENTJ_BASE_URL, pass --base-url, or add providers.custom.base_url in aj.json (e.g. a Bifrost gateway: http://localhost:8080/v1).".into());
            }
            if model_id.is_none() {
                return Err(
                    "Custom provider has no default model — set AGENTJ_MODEL, pass --model, or add providers.custom.model in aj.json."
                        .into(),
                );
            }
            Ok(())
        }
    }
}

/// Context-window size (total token budget) for a known model id, matched case-insensitively by
/// prefix. `None` when unknown, so callers omit the context meter rather than guess. Values are
/// approximate published limits; `AGENTJ_CONTEXT_WINDOW` overrides for a specific deployment.
pub fn context_window(model_id: &str) -> Option<u64> {
    const TABLE: &[(&str, u64)] = &[
        ("gpt-5", 400_000),
        ("gpt-4.1", 1_047_576),
        ("gpt-4o", 128_000),
        ("o4-mini", 200_000),
        ("o3", 200_000),
        ("o1", 200_000),
        ("claude", 200_000),
        ("gemini-2.5", 1_048_576),
        ("gemini-1.5", 1_048_576),
        ("gemini-2.0", 1_048_576),
    ];
    let id = model_id.to_ascii_lowercase();
    TABLE
        .iter()
        .find(|(prefix, _)| id.starts_with(prefix))
        .map(|(_, window)| *window)
}

/// Resolve a runnable model config. Callers preflight first.
pub fn resolve_model(sel: &Selector, app: &AppConfig) -> Result<ModelConfig, String> {
    let model_id = resolved_model(sel, app)
        .or_else(|| default_model(sel.provider).map(|s| s.to_string()))
        .ok_or_else(|| {
            format!(
                "No model id for provider \"{}\" — set AGENTJ_MODEL, pass --model, or add providers.{}.model in aj.json.",
                sel.provider.as_str(),
                sel.provider.as_str()
            )
        })?;

    let (base_url, api_key, api_version) = match sel.provider {
        Provider::Azure => (azure_base_url(app), azure_api_key(app), azure_api_version(app)),
        Provider::Custom => (custom_base_url(sel.base_url, app), custom_api_key(app), None),
        Provider::Vertex => (String::new(), None, None),
        Provider::Anthropic => (String::new(), anthropic_api_key(app), None),
    };
    Ok(ModelConfig {
        provider: sel.provider,
        model_id,
        base_url,
        api_key,
        api_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_resolution() {
        let empty = AppConfig::default();
        assert_eq!(resolve_provider(Some("anthropic"), &empty), Provider::Anthropic);
        assert_eq!(resolve_provider(Some("azure"), &empty), Provider::Azure);
        assert_eq!(resolve_provider(Some("custom"), &empty), Provider::Custom);
        assert_eq!(resolve_provider(Some("openai"), &empty), Provider::Vertex);
        assert_eq!(resolve_provider(None, &empty), Provider::Vertex);
        assert_eq!(
            resolve_provider(
                None,
                &AppConfig {
                    provider: Some("azure".into()),
                    ..Default::default()
                }
            ),
            Provider::Azure
        );
    }

    #[test]
    fn context_window_prefix_lookup() {
        assert_eq!(context_window("gpt-4o-mini"), Some(128_000));
        assert_eq!(context_window("GPT-5.2"), Some(400_000)); // case-insensitive
        assert_eq!(context_window("claude-opus-4-8"), Some(200_000));
        assert_eq!(context_window("gemini-2.5-pro"), Some(1_048_576));
        assert_eq!(context_window("some-unknown-model"), None);
    }

    #[test]
    fn preflight_messages() {
        // custom without a base url / model
        let s = Selector {
            provider: Provider::Custom,
            model: None,
            base_url: None,
        };
        assert!(preflight(&s, &AppConfig::default()).unwrap_err().contains("base URL"));
        let s = Selector {
            provider: Provider::Custom,
            model: Some("m"),
            base_url: Some("http://x/v1"),
        };
        assert!(preflight(&s, &AppConfig::default()).is_ok());
    }

    #[test]
    fn provider_blocks_fill_in_provider_specific_values() {
        let app = AppConfig {
            providers: crate::config::ProvidersConfig {
                azure: crate::config::ProviderConfig {
                    base_url: Some("https://azure.example/openai/v1".into()),
                    model: Some("deployment-a".into()),
                    api_version: Some("2025-05-01-preview".into()),
                    ..Default::default()
                },
                custom: crate::config::ProviderConfig {
                    base_url: Some("http://localhost:8080/v1".into()),
                    model: Some("gpt-4.1".into()),
                    ..Default::default()
                },
                anthropic: crate::config::ProviderConfig {
                    model: Some("claude-opus-4-8".into()),
                    ..Default::default()
                },
                vertex: crate::config::ProviderConfig {
                    project: Some("vertex-project".into()),
                    model: Some("gemini-2.5-pro".into()),
                    ..Default::default()
                },
            },
            ..Default::default()
        };

        assert!(preflight(
            &Selector {
                provider: Provider::Azure,
                model: None,
                base_url: None,
            },
            &app,
        )
        .is_ok());

        let custom = resolve_model(
            &Selector {
                provider: Provider::Custom,
                model: None,
                base_url: None,
            },
            &app,
        )
        .unwrap();
        assert_eq!(custom.model_id, "gpt-4.1");
        assert_eq!(custom.base_url, "http://localhost:8080/v1");

        let anthropic = resolve_model(
            &Selector {
                provider: Provider::Anthropic,
                model: None,
                base_url: None,
            },
            &app,
        )
        .unwrap();
        assert_eq!(anthropic.model_id, "claude-opus-4-8");

        let vertex = resolve_model(
            &Selector {
                provider: Provider::Vertex,
                model: None,
                base_url: None,
            },
            &app,
        )
        .unwrap();
        assert_eq!(vertex.model_id, "gemini-2.5-pro");
    }

    #[test]
    fn provider_blocks_override_top_level_file_values_but_not_env_or_cli() {
        let app = AppConfig {
            model: Some("top-level-model".into()),
            base_url: Some("http://top-level/v1".into()),
            providers: crate::config::ProvidersConfig {
                custom: crate::config::ProviderConfig {
                    base_url: Some("http://provider/v1".into()),
                    model: Some("provider-model".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };

        let from_file = resolve_model(
            &Selector {
                provider: Provider::Custom,
                model: None,
                base_url: None,
            },
            &app,
        )
        .unwrap();
        assert_eq!(from_file.model_id, "provider-model");
        assert_eq!(from_file.base_url, "http://provider/v1");

        let from_cli = resolve_model(
            &Selector {
                provider: Provider::Custom,
                model: Some("cli-model"),
                base_url: Some("http://cli/v1"),
            },
            &app,
        )
        .unwrap();
        assert_eq!(from_cli.model_id, "cli-model");
        assert_eq!(from_cli.base_url, "http://cli/v1");
    }
}
