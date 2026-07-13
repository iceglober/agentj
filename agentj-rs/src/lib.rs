//! agentj as a library.
//!
//! The `agentj` binary (`src/main.rs`) is the terminal app; this lib exposes the same module tree
//! so OTHER front-ends — notably the `agentj-desktop` Tauri app — can embed the real agent loop
//! (`agent::Session` + `agent::run_turn`, streaming `events::AgentEvent`) instead of shelling out to
//! the CLI and parsing text. The binary declares its own module tree, so this target is additive:
//! it changes nothing about how the TUI builds or runs.

pub mod agent;
pub mod commands;
pub mod config;
pub mod events;
pub mod exec;
pub mod hooks;
pub mod jobs;
pub mod mcp;
pub mod model;
pub mod prompt;
pub mod provider;
pub mod rekey;
pub mod session;
pub mod tools;
pub mod tui;
pub mod util;
pub mod worktree;
