//! The guided first-run provider setup: the wizard state and the `App` methods that drive it.

use super::{App, AppEffect};
use crate::model::Provider;

/// Values collected by the setup wizard, handed to the event loop to persist + build a client.
#[derive(Clone, Debug)]
pub struct ProviderSetup {
    pub provider: Provider,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SetupStep {
    Provider,
    BaseUrl,
    ApiKey,
    Model,
}

/// The guided first-run provider setup, rendered as a modal form. Collects one field per Enter; the
/// ApiKey step masks input. `error` holds the last validation message, shown in the modal.
pub struct SetupWizard {
    pub step: SetupStep,
    pub provider: Option<Provider>,
    pub base_url: String,
    pub api_key: String,
    pub error: Option<String>,
}

impl App {
    /// Open the guided provider-setup modal at the first field.
    pub fn start_setup(&mut self) {
        self.editor.clear();
        self.setup = Some(SetupWizard {
            step: SetupStep::Provider,
            provider: None,
            base_url: String::new(),
            api_key: String::new(),
            error: None,
        });
        self.dirty = true;
    }

    /// Cancel the wizard (Esc). Leaves the session unconfigured; `/setup` reopens it.
    pub fn cancel_setup(&mut self) -> AppEffect {
        self.setup = None;
        self.editor.clear();
        self.notice("setup canceled — run /setup to configure a provider");
        AppEffect::None
    }

    /// Feed one submitted field into the wizard, advancing a step or (on the last) emitting the effect
    /// that persists the config and builds the client. Validation messages go into `error` for the
    /// modal to show; nothing touches the transcript.
    pub(super) fn advance_setup(&mut self, line: &str) -> AppEffect {
        let line = line.trim().to_string();
        let Some(w) = self.setup.as_mut() else {
            return AppEffect::None;
        };
        self.dirty = true;
        w.error = None;
        match w.step {
            SetupStep::Provider => {
                let provider = match line.to_lowercase().as_str() {
                    "1" | "azure" => Provider::Azure,
                    "2" | "custom" => Provider::Custom,
                    _ => {
                        w.error = Some("pick 1 (azure) or 2 (custom)".into());
                        return AppEffect::None;
                    }
                };
                w.provider = Some(provider);
                w.step = SetupStep::BaseUrl;
            }
            SetupStep::BaseUrl => {
                if line.is_empty() {
                    w.error = Some("the base URL can't be empty".into());
                    return AppEffect::None;
                }
                w.base_url = line;
                w.step = SetupStep::ApiKey;
            }
            SetupStep::ApiKey => {
                w.api_key = line;
                w.step = SetupStep::Model;
            }
            SetupStep::Model => {
                if line.is_empty() {
                    w.error = Some("the model can't be empty".into());
                    return AppEffect::None;
                }
                return AppEffect::ConfigureProvider(ProviderSetup {
                    provider: w.provider.unwrap_or(Provider::Custom),
                    base_url: w.base_url.clone(),
                    api_key: w.api_key.clone(),
                    model: line,
                });
            }
        }
        AppEffect::None
    }

    /// The wizard succeeded: close the modal and confirm.
    pub fn finish_setup(&mut self, msg: impl Into<String>) {
        self.setup = None;
        self.editor.clear();
        self.notice(msg.into());
    }

    /// The wizard's values didn't produce a working client: reopen at the first field with the error.
    pub fn setup_failed(&mut self, msg: impl Into<String>) {
        self.start_setup();
        if let Some(w) = self.setup.as_mut() {
            w.error = Some(msg.into());
        }
    }
}
