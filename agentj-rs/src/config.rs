//! Runtime knobs and app config, resolved once at startup instead of re-read on every loop
//! iteration.

use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "base_url")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    /// API key stored in the config (the onboarding wizard writes this). Env still wins; keeping it
    /// here is what lets agentj "just work" without exporting a key every session.
    #[serde(default)]
    pub api_key: Option<String>,
}

impl ProviderConfig {
    fn merge(&mut self, other: Self) {
        self.model = other.model.or(self.model.take());
        self.base_url = other.base_url.or(self.base_url.take());
        self.api_version = other.api_version.or(self.api_version.take());
        self.project = other.project.or(self.project.take());
        self.api_key = other.api_key.or(self.api_key.take());
    }

    fn value(field: &Option<String>) -> Option<String> {
        field.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string())
    }

    pub fn model(&self) -> Option<String> {
        Self::value(&self.model)
    }

    pub fn base_url(&self) -> Option<String> {
        Self::value(&self.base_url)
    }


    pub fn api_version(&self) -> Option<String> {
        Self::value(&self.api_version)
    }

    pub fn project(&self) -> Option<String> {
        Self::value(&self.project)
    }

    pub fn api_key(&self) -> Option<String> {
        Self::value(&self.api_key)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProvidersConfig {
    #[serde(default)]
    pub vertex: ProviderConfig,
    #[serde(default)]
    pub anthropic: ProviderConfig,
    #[serde(default)]
    pub azure: ProviderConfig,
    #[serde(default)]
    pub custom: ProviderConfig,
}

impl ProvidersConfig {
    fn merge(&mut self, other: Self) {
        self.vertex.merge(other.vertex);
        self.anthropic.merge(other.anthropic);
        self.azure.merge(other.azure);
        self.custom.merge(other.custom);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "base_url")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub providers: ProvidersConfig,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub max_steps: Option<u64>,
    #[serde(default)]
    pub max_idle_nudges: Option<u64>,
    #[serde(default)]
    pub job_idle_wait_s: Option<u64>,
    /// The project's check command (tests/build/lint), e.g. "cargo test". Drives the ASSESS gate
    /// and is surfaced in the system prompt.
    #[serde(default)]
    pub check: Option<String>,
}

impl AppConfig {
    fn merge(&mut self, other: Self) {
        self.provider = other.provider.or(self.provider.take());
        self.model = other.model.or(self.model.take());
        self.base_url = other.base_url.or(self.base_url.take());
        self.providers.merge(other.providers);
        self.company = other.company.or(self.company.take());
        self.max_steps = other.max_steps.or(self.max_steps.take());
        self.max_idle_nudges = other.max_idle_nudges.or(self.max_idle_nudges.take());
        self.job_idle_wait_s = other.job_idle_wait_s.or(self.job_idle_wait_s.take());
        self.check = other.check.or(self.check.take());
    }

    pub fn load(root: &str) -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut cfg = AppConfig::default();
        for path in [
            Path::new(&home).join(".config").join("aj").join("aj.json"),
            Path::new(root).join(".aj").join("aj.json"),
            Path::new(root).join(".aj").join("aj.local.json"),
        ] {
            cfg.merge(read_config(&path));
        }
        cfg
    }

    pub fn env_or_file(key: &str, file: Option<&str>) -> Option<String> {
        std::env::var(key)
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| file.filter(|s| !s.is_empty()).map(|s| s.to_string()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// Max model steps in one turn (`AGENTJ_MAX_STEPS`).
    pub max_steps: usize,
    /// How many times a turn may idle-wait for a background-job nudge (`AGENTJ_MAX_IDLE_NUDGES`).
    pub max_idle_nudges: usize,
    /// Ceiling on a single idle-wait (`AGENTJ_JOB_IDLE_WAIT_S`).
    pub idle_wait: Duration,
    /// Bound on subagents running at once (`AGENTJ_MAX_PARALLEL_SUBAGENTS`).
    pub max_parallel_subagents: usize,
    /// Model context window for the context meter: `AGENTJ_CONTEXT_WINDOW` > model table > `None`.
    pub context_window: Option<u64>,
    /// Compact older tool-result bodies once a model call's prompt exceeds this many tokens. This is a
    /// window-safety valve, NOT a token-tail fix (a live A/B showed body-elision doesn't dent the
    /// many-round-trip tail): `AGENTJ_COMPACT_THRESHOLD` > 70% of the model window > 96000 when the
    /// window is unknown. Keyed to the window on purpose — a low absolute default (an earlier 12000)
    /// fired on every call of a genuinely large task and shredded the exploration context the model
    /// still needed (e.g. reading a whole monorepo, then writing per-package docs FROM those reads).
    pub compact_threshold: u64,
    /// The project's check command (`AGENTJ_CHECK` > aj.json `check` > None → heuristics).
    pub check: Option<String>,
    /// When the model goes idle with work still framed but unfinished, consult a fresh-context
    /// judge inference for a keep-going/stop verdict instead of ending the turn (`AGENTJ_CONTINUATION_JUDGE`,
    /// default ON; set `0`/`false` to disable). Bounds premature "shall I proceed?" stops on
    /// long-horizon autonomous work.
    pub continuation_judge: bool,
    /// When true, the turn does NOT block waiting on background jobs — it ends and goes idle, and the
    /// HOST wakes a fresh turn when a job pings (finish / soft timeout). Set by the desktop app so a
    /// running job never holds the turn open; the CLI/TUI leave it false and idle-wait in-turn.
    pub host_manages_jobs: bool,
}

impl Config {
    pub fn from_sources(model_id: &str, app: &AppConfig) -> Self {
        Self::parse(
            |k| std::env::var(k).ok(),
            model_id,
            RuntimeFileConfig {
                max_steps: app.max_steps,
                max_idle_nudges: app.max_idle_nudges,
                job_idle_wait_s: app.job_idle_wait_s,
                check: app.check.clone(),
            },
        )
    }

    /// Pure resolver (a `get` closure stands in for the environment) so it's testable without
    /// mutating process-global env in parallel tests.
    fn parse(
        get: impl Fn(&str) -> Option<String>,
        model_id: &str,
        file: RuntimeFileConfig,
    ) -> Self {
        let env_num = |k: &str| get(k).and_then(|s| s.parse::<u64>().ok());
        let num = |k: &str, file_value: Option<u64>| env_num(k).or(file_value);
        let env_flag_default_on =
            |k: &str| get(k).is_none_or(|s| !(s == "0" || s.eq_ignore_ascii_case("false")));
        let context_window = env_num("AGENTJ_CONTEXT_WINDOW").or_else(|| crate::model::context_window(model_id));
        Config {
            max_steps: num("AGENTJ_MAX_STEPS", file.max_steps)
                .filter(|n| *n >= 1)
                .unwrap_or(40) as usize,
            max_idle_nudges: num("AGENTJ_MAX_IDLE_NUDGES", file.max_idle_nudges).unwrap_or(6) as usize,
            idle_wait: Duration::from_secs(num("AGENTJ_JOB_IDLE_WAIT_S", file.job_idle_wait_s).unwrap_or(120)),
            max_parallel_subagents: env_num("AGENTJ_MAX_PARALLEL_SUBAGENTS")
                .filter(|n| *n >= 1)
                .unwrap_or(4) as usize,
            context_window,
            // Absolute (not window-relative) so it fires on big-window models; clamp below 70% of the
            // window when one is known so a small-window model never compacts too late.
            compact_threshold: env_num("AGENTJ_COMPACT_THRESHOLD")
                .filter(|n| *n >= 1000)
                .or_else(|| context_window.map(|w| w * 7 / 10))
                .unwrap_or(96_000),
            check: get("AGENTJ_CHECK").filter(|s| !s.is_empty()).or(file.check),
            continuation_judge: env_flag_default_on("AGENTJ_CONTINUATION_JUDGE"),
            host_manages_jobs: false,
        }
    }
}

#[derive(Clone)]
struct RuntimeFileConfig {
    max_steps: Option<u64>,
    max_idle_nudges: Option<u64>,
    job_idle_wait_s: Option<u64>,
    check: Option<String>,
}

/// Persist a provider setup to the GLOBAL config (`~/.config/aj/aj.json`) so every repo picks it up.
/// Merges into any existing file (keeping other settings and provider blocks), makes it the default
/// provider+model, and tightens the file to 0600 since it now holds a key. Returns the written path.
pub fn write_provider_config(
    provider: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
    api_version: Option<&str>,
) -> std::io::Result<std::path::PathBuf> {
    use serde_json::{json, Value};
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = Path::new(&home).join(".config").join("aj");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("aj.json");

    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));

    root["provider"] = json!(provider);
    root["model"] = json!(model);
    if !root["providers"].is_object() {
        root["providers"] = json!({});
    }
    let block = root["providers"]
        .as_object_mut()
        .expect("providers is an object")
        .entry(provider.to_string())
        .or_insert_with(|| json!({}));
    if !block.is_object() {
        *block = json!({});
    }
    let b = block.as_object_mut().expect("block is an object");
    b.insert("base_url".into(), json!(base_url));
    b.insert("model".into(), json!(model));
    b.insert("api_key".into(), json!(api_key));
    if let Some(v) = api_version {
        b.insert("api_version".into(), json!(v));
    }

    std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

fn read_config(path: &Path) -> AppConfig {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(cfg) => cfg,
            Err(err) => {
                eprintln!("warning: ignoring invalid config file {}: {err}", path.display());
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(pairs: &[(&str, &str)]) -> Config {
        from_all(
            pairs,
            "unknown-model",
            RuntimeFileConfig {
                max_steps: None,
                max_idle_nudges: None,
                job_idle_wait_s: None,
                check: None,
            },
        )
    }

    fn e_file() -> RuntimeFileConfig {
        RuntimeFileConfig {
            max_steps: None,
            max_idle_nudges: None,
            job_idle_wait_s: None,
            check: Some("make check".into()),
        }
    }

    fn from_all(pairs: &[(&str, &str)], model_id: &str, file: RuntimeFileConfig) -> Config {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::parse(|k| map.get(k).cloned(), model_id, file)
    }

    #[test]
    fn parse_defaults_and_invalid_values() {
        let d = from(&[]);
        assert_eq!(d.max_steps, 40);
        assert_eq!(d.max_idle_nudges, 6);
        assert_eq!(d.idle_wait, Duration::from_secs(120));
        assert_eq!(d.max_parallel_subagents, 4);
        assert_eq!(d.context_window, None);

        assert_eq!(from(&[("AGENTJ_MAX_STEPS", "0")]).max_steps, 40);
        assert_eq!(from(&[("AGENTJ_MAX_STEPS", "nope")]).max_steps, 40);
        assert_eq!(from(&[("AGENTJ_MAX_PARALLEL_SUBAGENTS", "0")]).max_parallel_subagents, 4);

        let o = from(&[
            ("AGENTJ_MAX_STEPS", "10"),
            ("AGENTJ_MAX_IDLE_NUDGES", "2"),
            ("AGENTJ_JOB_IDLE_WAIT_S", "30"),
            ("AGENTJ_MAX_PARALLEL_SUBAGENTS", "8"),
        ]);
        assert_eq!(o.max_steps, 10);
        assert_eq!(o.max_idle_nudges, 2);
        assert_eq!(o.idle_wait, Duration::from_secs(30));
        assert_eq!(o.max_parallel_subagents, 8);
    }

    #[test]
    fn file_values_fill_in_and_env_overrides_them() {
        let file = RuntimeFileConfig {
            max_steps: Some(9),
            max_idle_nudges: Some(3),
            job_idle_wait_s: Some(15),
            check: Some("make check".into()),
        };
        let d = from_all(&[], "unknown-model", file.clone());
        assert_eq!(d.max_steps, 9);
        assert_eq!(d.max_idle_nudges, 3);
        assert_eq!(d.idle_wait, Duration::from_secs(15));
        assert_eq!(d.max_parallel_subagents, 4);
        assert_eq!(d.context_window, None);

        let e = from_all(&[("AGENTJ_MAX_STEPS", "11")], "unknown-model", file);
        assert_eq!(e.max_steps, 11);
        assert_eq!(e.check.as_deref(), Some("make check"));
        assert_eq!(
            from_all(&[("AGENTJ_CHECK", "bun test")], "unknown-model", e_file()).check.as_deref(),
            Some("bun test")
        );
    }

    #[test]
    fn continuation_judge_defaults_on_and_only_an_explicit_off_disables_it() {
        assert!(from(&[]).continuation_judge, "on by default");
        assert!(from(&[("AGENTJ_CONTINUATION_JUDGE", "1")]).continuation_judge);
        assert!(from(&[("AGENTJ_CONTINUATION_JUDGE", "anything")]).continuation_judge, "unknown value stays on");
        assert!(!from(&[("AGENTJ_CONTINUATION_JUDGE", "0")]).continuation_judge);
        assert!(!from(&[("AGENTJ_CONTINUATION_JUDGE", "false")]).continuation_judge);
    }

    #[test]
    fn compact_threshold_tracks_the_window_with_an_absolute_fallback() {
        // Unknown window → a high absolute fallback (compaction is a rare safety valve, not per-call).
        assert_eq!(from(&[]).compact_threshold, 96_000);
        // Env override wins (floor of 1000; below it, fall back to the window/default).
        assert_eq!(from(&[("AGENTJ_COMPACT_THRESHOLD", "40000")]).compact_threshold, 40_000);
        assert_eq!(from(&[("AGENTJ_COMPACT_THRESHOLD", "500")]).compact_threshold, 96_000);
        // A known window sets the threshold to 70% of it — so a 400k model compacts near 280k, not on
        // every call of a large task.
        assert_eq!(from(&[("AGENTJ_CONTEXT_WINDOW", "400000")]).compact_threshold, 280_000);
        assert_eq!(from(&[("AGENTJ_CONTEXT_WINDOW", "8000")]).compact_threshold, 5_600);
    }

    #[test]
    fn context_window_env_overrides_model_table() {
        assert_eq!(
            from_all(
                &[],
                "gpt-4o",
                RuntimeFileConfig {
                    max_steps: None,
                    max_idle_nudges: None,
                    job_idle_wait_s: None,
                    check: None,
                }
            )
            .context_window,
            Some(128_000)
        );
        assert_eq!(
            from_all(
                &[("AGENTJ_CONTEXT_WINDOW", "500000")],
                "gpt-4o",
                RuntimeFileConfig {
                    max_steps: None,
                    max_idle_nudges: None,
                    job_idle_wait_s: None,
                    check: None,
                }
            )
            .context_window,
            Some(500_000)
        );
        assert_eq!(from(&[]).context_window, None);
    }

    #[test]
    fn app_config_merge_is_layered() {
        let mut cfg = AppConfig {
            provider: Some("vertex".into()),
            model: Some("one".into()),
            ..Default::default()
        };
        cfg.merge(AppConfig {
            model: Some("two".into()),
            base_url: Some("http://x".into()),
            providers: ProvidersConfig {
                azure: ProviderConfig {
                    model: Some("deployment-a".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        });
        cfg.merge(AppConfig {
            company: Some("iceglober".into()),
            providers: ProvidersConfig {
                azure: ProviderConfig {
                    api_version: Some("2025-01-01".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        });
        assert_eq!(cfg.provider.as_deref(), Some("vertex"));
        assert_eq!(cfg.model.as_deref(), Some("two"));
        assert_eq!(cfg.base_url.as_deref(), Some("http://x"));
        assert_eq!(cfg.company.as_deref(), Some("iceglober"));
        assert_eq!(cfg.providers.azure.model(), Some("deployment-a".into()));
        assert_eq!(cfg.providers.azure.api_version(), Some("2025-01-01".into()));
    }

    #[test]
    fn read_config_rejects_unknown_keys() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("aj.json");
        std::fs::write(&path, r#"{"provider":"custom","providers":{"custom":{"not_a_field":"x"}}}"#).unwrap();
        assert_eq!(read_config(&path), AppConfig::default());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn env_or_file_prefers_env_then_file_then_none() {
        // Uniquely-named key so setting it can't race other tests reading process-global env.
        let key = "__AGENTJ_TEST_ENV_WINS__";
        std::env::set_var(key, "from-env");
        assert_eq!(AppConfig::env_or_file(key, Some("file")), Some("from-env".into()), "env wins over file");
        // An empty env value is treated as unset and falls through to the file.
        std::env::set_var(key, "");
        assert_eq!(AppConfig::env_or_file(key, Some("file")), Some("file".into()));
        std::env::remove_var(key);
        assert_eq!(AppConfig::env_or_file("__AGENTJ_TEST_MISSING__", Some("file")), Some("file".into()));
        assert_eq!(AppConfig::env_or_file("__AGENTJ_TEST_MISSING__", Some("")), None);
    }
}
