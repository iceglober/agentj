//! agentj — CLI entry (ratatui edition). Parses flags, runs `--once` headlessly, the interactive
//! ratatui chat, or `mcp` subcommands.

mod agent;
mod commands;
mod config;
mod events;
mod exec;
mod jobs;
mod mcp;
mod model;
mod prompt;
mod provider;
mod rekey;
mod subagent;
mod tools;
mod tui;
mod util;
mod webcheck;

use events::AgentEvent;
use model::{preflight, resolve_model, resolve_provider, Provider, Selector};
use provider::{ChatMessage, Llm};
use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::Arc;
use tools::Tools;

const HELP: &str = "\
agentj — a simple terminal coding agent (ratatui edition)

Usage:
  agentj                     chat in the current repo (full-screen ratatui)
  agentj --once \"<task>\"      run one task headlessly, then exit
  agentj mcp list            show configured MCP servers + tool count

Options:
  --provider <name>   vertex | anthropic | azure | custom (env AGENTJ_PROVIDER; default vertex)
  --model <id>        model id (env AGENTJ_MODEL; required for azure/custom)
  --base-url <url>    endpoint for --provider custom (env AGENTJ_BASE_URL)
  -h, --help          show this help
  -v, --version       show version

Notes: app config is loaded from ~/.config/aj/aj.json, ./.aj/aj.json, and ./.aj/aj.local.json
(project-local wins; env overrides files; CLI overrides env). Provider-specific config can live under
`providers.<name>` in aj.json, e.g. `providers.azure.model` / `providers.custom.base_url`, so you can
set non-secret provider defaults once and reuse them. API keys remain environment-only and per-developer.
Azure/custom (OpenAI-compatible) providers are wired;
vertex/anthropic are staged. MCP works for stdio + no-auth streamable-http servers (from .mcp.json);
static-header/OAuth servers are staged.";

struct Args {
    provider: Option<Provider>,
    model: Option<String>,
    base_url: Option<String>,
    once: Option<String>,
    help: bool,
    version: bool,
}

fn parse_args(argv: &[String]) -> Args {
    let mut a = Args {
        provider: None,
        model: None,
        base_url: None,
        once: None,
        help: false,
        version: false,
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "-h" | "--help" => a.help = true,
            "-v" | "--version" => a.version = true,
            "--provider" => {
                i += 1;
                a.provider = argv
                    .get(i)
                    .map(|s| resolve_provider(Some(s), &config::AppConfig::default()));
            }
            "--model" => {
                i += 1;
                a.model = argv.get(i).cloned();
            }
            "--base-url" => {
                i += 1;
                a.base_url = argv.get(i).cloned();
            }
            "--once" => {
                i += 1;
                a.once = argv.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }
    a
}

/// The git repo root for cwd, or cwd itself when it isn't a git repo.
async fn repo_root() -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into());
    if let Ok(o) = exec::run(&["git", "rev-parse", "--show-toplevel"], &cwd, None).await {
        let top = o.stdout.trim();
        if o.exit_code == 0 && !top.is_empty() {
            return top.to_string();
        }
    }
    cwd
}

/// `agentj mcp <list|login|logout>`.
async fn run_mcp(sub: &[String]) {
    let root = repo_root().await;
    let configs = mcp::config::load_mcp_servers(&root);
    match sub.first().map(|s| s.as_str()) {
        Some("list") => {
            if configs.is_empty() {
                println!(
                    "No MCP servers configured (.mcp.json not found in this repo or ~/.agentj/)."
                );
                return;
            }
            println!("Configured MCP servers:");
            for c in &configs {
                println!("  {:20} {:?}", c.name, c.transport);
            }
            let (clients, statuses) = mcp::client::connect_all(&configs).await;
            println!("Connected: {} tool(s) available.", clients.tool_count());
            for s in statuses {
                match s.outcome {
                    mcp::client::McpOutcome::Ok(n) => println!("  ✓ {:20} {n} tool(s)", s.name),
                    mcp::client::McpOutcome::NeedsAuth => {
                        println!("  ✎ {:20} needs authorization — `agentj mcp login {}`", s.name, s.name)
                    }
                    mcp::client::McpOutcome::Err(e) => println!("  ✗ {:20} {e}", s.name),
                }
            }
            clients.shutdown();
        }
        Some("login") => {
            let Some(name) = sub.get(1) else {
                println!("usage: agentj mcp login <server-name>");
                return;
            };
            let Some(cfg) = configs.iter().find(|c| &c.name == name) else {
                println!("no MCP server named `{name}` in .mcp.json");
                return;
            };
            let Some(url) = cfg.url.clone() else {
                println!("`{name}` is a stdio server — OAuth login applies to http/sse servers");
                return;
            };
            match mcp::oauth::login(&url, |m| println!("  {m}")).await {
                Ok(()) => println!("✓ {name} authorized — it will connect automatically from now on"),
                Err(e) => println!("✗ authorization failed: {e}"),
            }
        }
        Some("logout") => {
            let Some(name) = sub.get(1) else {
                println!("usage: agentj mcp logout <server-name>");
                return;
            };
            match configs.iter().find(|c| &c.name == name).and_then(|c| c.url.clone()) {
                Some(url) => {
                    mcp::oauth::forget(&url);
                    println!("✓ {name}: cached credentials removed");
                }
                None => println!("no http/sse MCP server named `{name}` in .mcp.json"),
            }
        }
        _ => println!("usage: agentj mcp <list | login <name> | logout <name>>"),
    }
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&argv);

    if args.help {
        println!("{HELP}");
        return;
    }
    if args.version {
        println!("agentj {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if argv.first().map(|s| s.as_str()) == Some("mcp") {
        run_mcp(&argv[1..]).await;
        return;
    }

    let root = repo_root().await;
    let app_cfg = config::AppConfig::load(&root);

    let provider = args.provider.unwrap_or_else(|| resolve_provider(None, &app_cfg));
    let sel = Selector {
        provider,
        model: args.model.as_deref(),
        base_url: args.base_url.as_deref(),
    };
    let interactive = std::io::stdin().is_terminal() && args.once.is_none();

    // Build a working client. If it fails AND we're interactive, launch into the setup wizard instead
    // of exiting — the user configures a provider in-app. Headless (`--once`) still hard-errors.
    let (llm, provider_name, model_id, needs_setup) = match preflight(&sel, &app_cfg)
        .and_then(|_| resolve_model(&sel, &app_cfg))
        .and_then(|cfg| Llm::from_config(&cfg).map(|l| (cfg, l)).map_err(|e| e.to_string()))
    {
        Ok((cfg, llm)) => (llm, cfg.provider.as_str().to_string(), cfg.model_id, false),
        Err(_) if interactive => {
            (Llm::Unconfigured, provider.as_str().to_string(), "(none)".to_string(), true)
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let company = config::AppConfig::env_or_file("AGENTJ_COMPANY", app_cfg.company.as_deref());
    // Resolve the runtime config once, before the prompt, so the check command shown to the model and
    // the one the ASSESS gate enforces come from the same source and can't diverge.
    let run_cfg = config::Config::from_sources(&model_id, &app_cfg);
    let system = prompt::system_prompt(&root, company.as_deref(), run_cfg.check.as_deref());

    // Connect MCP servers once at startup; results are surfaced in the TUI (a modal on failure), not
    // spewed to the terminal.
    let mcp_configs = mcp::config::load_mcp_servers(&root);
    let (mcp_clients, mcp_status) = if mcp_configs.is_empty() {
        (None, Vec::new())
    } else {
        let (c, n) = mcp::client::connect_all(&mcp_configs).await;
        (Some(Arc::new(c)), n)
    };

    let jobs = jobs::JobManager::new(root.clone());
    // Kept so every exit path below can kill MCP child-process trees (else an orphaned mcp-remote
    // keeps holding its OAuth callback port and the next launch dies with EADDRINUSE).
    let mcp_for_shutdown = mcp_clients.clone();
    let tools = Tools::new(PathBuf::from(&root), jobs.clone(), mcp_clients);
    let sess = agent::Session {
        llm: Arc::new(llm),
        tools: Arc::new(tools),
        cfg: Arc::new(run_cfg),
    };

    if !std::io::stdin().is_terminal() && args.once.is_none() {
        eprintln!("stdin is not a terminal; interactive chat needs a TTY. Use --once \"<task>\" for headless runs.");
        std::process::exit(1);
    }

    if let Some(task) = args.once {
        // Headless one-shot: run a turn, print events to stdout, exit on the result.
        for s in &mcp_status {
            match &s.outcome {
                mcp::client::McpOutcome::Err(e) => eprintln!("! MCP \"{}\": {e}", s.name),
                mcp::client::McpOutcome::NeedsAuth => eprintln!(
                    "! MCP \"{}\": needs authorization — run `agentj mcp login {}` once",
                    s.name, s.name
                ),
                mcp::client::McpOutcome::Ok(_) => {}
            }
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        let turn_sess = sess.clone();
        let turn = tokio::spawn(async move {
            let mut messages = vec![ChatMessage::system(system), ChatMessage::user(task)];
            let _ = agent::run_turn(&turn_sess, &mut messages, &tx, true, None).await;
        });
        let mut failed = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                AgentEvent::Message(t) => println!("{t}"),
                AgentEvent::ToolStart { name, args, .. } => println!("· {name}({args})"),
                AgentEvent::ToolEnd {
                    summary,
                    elapsed_ms,
                    ..
                } => println!("  → {summary} ({elapsed_ms}ms)"),
                AgentEvent::SubagentStart { id, desc } => println!("↳[{id}] {desc}"),
                AgentEvent::SubagentProgress { id, status } => println!("↳[{id}] {status}"),
                AgentEvent::SubagentEnd {
                    id,
                    ok,
                    summary,
                    elapsed_ms,
                } => println!(
                    "↳[{id}] {} ({elapsed_ms}ms) — {summary}",
                    if ok { "done" } else { "FAILED" }
                ),
                AgentEvent::Usage(u) => println!(
                    "» tokens: {} in / {} out ({} total)",
                    u.prompt_tokens, u.completion_tokens, u.total_tokens
                ),
                AgentEvent::Note(t) => println!("» {t}"),
                AgentEvent::Error(e) => {
                    eprintln!("[error] {e}");
                    failed = true;
                }
                AgentEvent::Done => break,
            }
        }
        let _ = turn.await;
        jobs.kill_all().await;
        if let Some(m) = &mcp_for_shutdown {
            m.shutdown();
        }
        if failed {
            std::process::exit(1);
        }
        return;
    }

    let result = tui::run(
        provider_name,
        model_id,
        root,
        system,
        app_cfg,
        sess,
        mcp_status,
        needs_setup,
    )
    .await;
    jobs.kill_all().await;
    if let Some(m) = &mcp_for_shutdown {
        m.shutdown();
    }
    if let Err(e) = result {
        eprintln!("agentj: {e}");
        std::process::exit(1);
    }
}
