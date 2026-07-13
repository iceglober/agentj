use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn bin_path() -> PathBuf {
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_agentj") {
        return PathBuf::from(p);
    }
    let mut p = std::env::current_exe().expect("current_exe");
    p.pop(); // deps
    p.pop(); // debug|release
    p.push(if cfg!(windows) {
        "agentj.exe"
    } else {
        "agentj"
    });
    p
}

fn drain_until_quiet(
    rx: &mpsc::Receiver<Vec<u8>>,
    quiet_for: Duration,
    max_wait: Duration,
) -> Vec<u8> {
    let started = Instant::now();
    let mut last = Instant::now();
    let mut out = Vec::new();
    loop {
        let remaining = max_wait
            .checked_sub(started.elapsed())
            .unwrap_or_else(|| Duration::from_millis(0));
        if remaining.is_zero() {
            break;
        }
        let wait = quiet_for.min(remaining);
        match rx.recv_timeout(wait) {
            Ok(chunk) => {
                out.extend_from_slice(&chunk);
                last = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last.elapsed() >= quiet_for {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    out
}

/// Accumulate output until its ANSI-stripped text contains `needle` (or `max_wait` elapses).
/// Waiting for a concrete startup marker instead of "quiet for 200ms" matters: a cold debug binary
/// can stay silent longer than that, and input written before the TUI is up is eaten by the line
/// discipline instead of the app.
fn drain_until_contains(rx: &mpsc::Receiver<Vec<u8>>, needle: &str, max_wait: Duration) -> Vec<u8> {
    let started = Instant::now();
    let mut out = Vec::new();
    while started.elapsed() < max_wait {
        if strip_ansi(&String::from_utf8_lossy(&out)).contains(needle) {
            break;
        }
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
            out.extend_from_slice(&chunk);
        }
    }
    out
}

fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut out = String::with_capacity(s.len());
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&b) {
                        break;
                    }
                }
            } else if i < bytes.len() && bytes[i] == b']' {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if b == 0x07 {
                        break;
                    }
                    if b == 0x1b && i < bytes.len() && bytes[i] == b'\\' {
                        i += 1;
                        break;
                    }
                }
            }
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn run_once_with_input(input: &[u8]) -> String {
    run_with(&[], &[], input)
}

fn run_with(extra_args: &[&str], env: &[(&str, &str)], input: &[u8]) -> String {
    run_with_cwd(extra_args, env, input, None)
}

fn run_with_cwd(
    extra_args: &[&str],
    env: &[(&str, &str)],
    input: &[u8],
    cwd: Option<&std::path::Path>,
) -> String {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    // `custom` provider is satisfied entirely by --base-url + --model, so the harness needs no
    // ambient credentials (azure would require AZURE_BASE_URL/AZURE_API_KEY). The endpoint is a dead
    // port on purpose: these tests exercise input editing, never a live turn.
    let mut cmd = CommandBuilder::new(bin_path());
    cmd.arg("--provider");
    cmd.arg("custom");
    cmd.arg("--model");
    cmd.arg("dummy");
    cmd.arg("--base-url");
    cmd.arg("http://127.0.0.1:1");
    for a in extra_args {
        cmd.arg(a);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    match cwd {
        Some(dir) => cmd.cwd(dir),
        None => cmd.cwd(std::env::current_dir().expect("cwd")),
    }

    let mut child = pair.slave.spawn_command(cmd).expect("spawn command");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let mut writer = pair.master.take_writer().expect("take writer");
    let (tx, rx) = mpsc::channel();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Wait for the TUI to be up (the cheat sheet is its first transcript line) before typing, and
    // let it process the keystrokes before the writer drop delivers EOF.
    let mut early = drain_until_contains(&rx, "Enter send", Duration::from_secs(10));
    early.extend(drain_until_quiet(
        &rx,
        Duration::from_millis(200),
        Duration::from_secs(2),
    ));
    writer.write_all(input).expect("write input");
    writer.flush().expect("flush input");
    early.extend(drain_until_quiet(
        &rx,
        Duration::from_millis(500),
        Duration::from_secs(3),
    ));
    drop(writer);

    let status = child.wait().expect("wait child");
    assert!(status.success(), "agentj exited with {status:?}");

    let mut output = early;
    output.extend_from_slice(&drain_until_quiet(
        &rx,
        Duration::from_millis(200),
        Duration::from_secs(2),
    ));
    reader_thread.join().expect("join reader thread");
    output.extend_from_slice(&drain_until_quiet(
        &rx,
        Duration::from_millis(50),
        Duration::from_millis(200),
    ));

    strip_ansi(&String::from_utf8_lossy(&output))
}

#[test]
fn enter_submits_from_pty_in_interactive_mode() {
    let output = run_once_with_input(b"alpha\r");
    assert!(
        output.contains("alpha"),
        "expected submitted prompt text to appear in output, got:\n{output}"
    );
}

#[test]
fn shifted_printable_input_round_trips_through_pty() {
    let output = run_once_with_input(b"A:!\r");
    assert!(
        output.contains("A:!"),
        "expected shifted printable chars in submitted prompt, got:\n{output}"
    );
}

#[test]
fn ctrl_backspace_byte_deletes_a_word_through_pty() {
    let output = run_once_with_input(b"alpha beta\x17\r");
    assert!(
        output.contains("alpha"),
        "expected PTY ctrl-backspace byte to edit the input before submit, got:\n{output}"
    );
    assert!(
        !output.contains("alphabeta"),
        "expected PTY ctrl-backspace byte not to leave the full original input intact, got:\n{output}"
    );
}

#[test]
fn long_burst_input_survives_pty_round_trip() {
    // The transcript wraps long lines, so byte-exact survival is asserted on the persisted
    // history instead of the rendered screen: the submitted message must be the full payload.
    let home = std::env::temp_dir().join(format!("agentj-pty-burst-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mk temp home");

    let payload = "a".repeat(512);
    let mut input = payload.clone().into_bytes();
    input.push(b'\r');
    let output = run_with(&[], &[("HOME", home.to_str().unwrap())], &input);
    assert!(
        output.contains(&payload[..64]),
        "expected the burst to render in the transcript, got:\n{output}"
    );

    let sessions = home.join(".config/aj/sessions");
    let history = std::fs::read_dir(&sessions)
        .expect("session store exists")
        .flatten()
        .find_map(|e| std::fs::read_to_string(e.path().join("history.jsonl")).ok())
        .expect("a session persisted its history");
    let _ = std::fs::remove_dir_all(&home);
    let first: serde_json::Value =
        serde_json::from_str(history.lines().next().expect("one message")).expect("valid json");
    assert_eq!(first["role"], "user");
    assert_eq!(
        first["content"].as_str().unwrap(),
        payload,
        "the persisted prompt must be byte-identical to the typed burst"
    );
}

#[test]
fn resume_restores_the_persisted_conversation_through_pty() {
    // Fabricate a persisted session under a throwaway HOME: a meta.json (as Session::mint writes)
    // and a two-message history.jsonl — then launch the real binary with --resume and check the
    // conversation is replayed into the transcript.
    let home = std::env::temp_dir().join(format!("agentj-pty-resume-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let id = "11111111-2222-3333-4444-555555555555";
    let dir = home.join(".config/aj/sessions").join(id);
    std::fs::create_dir_all(dir.join("artifacts")).expect("mk session dir");
    std::fs::write(
        dir.join("meta.json"),
        format!(
            r#"{{"id":"{id}","worktree":"{}","branch":null,"created":0,"last_active":0}}"#,
            std::env::current_dir().unwrap().display()
        ),
    )
    .expect("write meta");
    std::fs::write(
        dir.join("history.jsonl"),
        concat!(
            r#"{"role":"user","content":"remember the zebra password"}"#,
            "\n",
            r#"{"role":"assistant","content":"Noted: the zebra password."}"#,
            "\n"
        ),
    )
    .expect("write history");

    let output = run_with(
        &["--resume", id],
        &[("HOME", home.to_str().unwrap())],
        b"\r",
    );
    let _ = std::fs::remove_dir_all(&home);

    // ASCII-only assertion: strip_ansi is byte-wise, so multibyte punctuation (the notice's
    // em-dash) doesn't survive it.
    assert!(
        output.contains("2 prior messages restored"),
        "expected the resume notice in the transcript, got:\n{output}"
    );
    assert!(
        output.contains("remember the zebra password"),
        "expected the restored user prompt in the transcript, got:\n{output}"
    );
    assert!(
        output.contains("Noted: the zebra password."),
        "expected the restored assistant reply in the transcript, got:\n{output}"
    );
}

#[test]
fn worktree_new_hook_runs_automatically_and_only_once_through_pty() {
    // A worktree with .aj/hooks/worktree_new: launching agentj must run it BEFORE the session is
    // usable, note it in the transcript, and stamp it so a second launch doesn't re-run it.
    let home = std::env::temp_dir().join(format!("agentj-pty-hook-home-{}", std::process::id()));
    let wt = std::env::temp_dir().join(format!("agentj-pty-hook-wt-{}", std::process::id()));
    for d in [&home, &wt] {
        let _ = std::fs::remove_dir_all(d);
    }
    std::fs::create_dir_all(home.as_path()).unwrap();
    std::fs::create_dir_all(wt.join(".aj/hooks")).unwrap();
    std::fs::write(
        wt.join(".aj/hooks/worktree_new"),
        "echo provisioned >> hook.log\necho toolchain-ready\n",
    )
    .unwrap();
    let env = [("HOME", home.to_str().unwrap())];

    let out1 = run_with_cwd(&[], &env, b"\r", Some(&wt));
    assert!(
        out1.contains("worktree_new hook") && out1.contains("toolchain-ready"),
        "expected the hook note (with output tail) in the transcript, got:\n{out1}"
    );
    let _ = run_with_cwd(&[], &env, b"\r", Some(&wt));
    let log = std::fs::read_to_string(wt.join("hook.log")).expect("hook ran");
    assert_eq!(
        log.lines().count(),
        1,
        "the hook must run exactly ONCE across launches (stamped), got log:\n{log}"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&wt);
}

#[test]
fn submitted_prompts_persist_and_continue_restores_them_through_pty() {
    // Full round trip through the real binary: run 1 submits a prompt (the turn itself dies on the
    // dead endpoint — the prompt still commits), run 2 with --continue must replay it.
    let home = std::env::temp_dir().join(format!("agentj-pty-continue-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mk temp home");
    let env = [("HOME", home.to_str().unwrap().to_string())];
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();

    let _ = run_with(&[], &env, b"persist across runs\r");
    let output = run_with(&["--continue"], &env, b"\r");
    let _ = std::fs::remove_dir_all(&home);

    assert!(
        output.contains("prior messages restored"),
        "expected --continue to restore the previous run's conversation, got:\n{output}"
    );
    assert!(
        output.contains("persist across runs"),
        "expected the previous run's prompt to replay in the transcript, got:\n{output}"
    );
}

#[test]
fn repeated_word_deletes_apply_before_submit_through_pty() {
    let output = run_once_with_input(b"alpha beta gamma\x17\x17\r");
    assert!(
        output.contains("gamma") || output.contains("beta") || output.contains("alpha"),
        "expected repeated PTY delete bytes to produce visible edited terminal output, got:\n{output}"
    );
    assert!(
        !output.contains("alphabeta gamma"),
        "expected repeated PTY delete bytes not to leave an undeleted merged prompt intact, got:\n{output}"
    );
}
