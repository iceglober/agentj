//! Background jobs. `job_start` spawns a long-running command (dev server, slow suite,
//! `gh pr checks --watch`) in its own process group and returns immediately — agentj keeps working.
//! When a job finishes, or its fallback timeout fires, a **nudge** is queued; the loop injects ready
//! nudges as user messages and idle-waits for one only when it has nothing else to do (see agent.rs).

use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

const OUTPUT_CAP: usize = 16 * 1024; // per-job captured-output ceiling (keep the tail)

#[derive(Clone, Copy, PartialEq)]
enum JobStatus {
    Running,
    Exited(i32),
}

struct JobHandle {
    command: String,
    cwd: PathBuf,
    started: Instant,
    timeout: Option<Duration>,
    state: Mutex<JobState>,
}

/// A running job's live status, snapshotted for the UI's activity panel.
#[derive(Clone)]
pub struct JobInfo {
    pub id: u64,
    pub command: String,
    pub started: Instant,
    pub timeout: Option<Duration>,
}

struct JobState {
    status: JobStatus,
    output: String,
    pid: Option<i32>,
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Trim `s` in place to keep roughly its last `cap` bytes. The cut is advanced to the next char
/// boundary so `split_off` can't panic when a lossy-decoded multibyte char straddles the cap.
fn trim_to_cap(s: &mut String, cap: usize) {
    let over = s.len().saturating_sub(cap);
    if over == 0 {
        return;
    }
    let mut cut = over;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    *s = s.split_off(cut);
}

pub struct JobManager {
    /// Retained for compatibility: existing callers may construct with a session root,
    /// though in-crate shell now uses `start_in`. See `start`.
    #[allow(dead_code)]
    root: String,
    jobs: Mutex<HashMap<u64, Arc<JobHandle>>>,
    next_id: AtomicU64,
    /// Queued finished/timed-out nudges. A plain `Mutex` — never held across `.await`.
    nudges: Arc<std::sync::Mutex<VecDeque<String>>>,
    /// Wakes an idle `next_nudge` when a nudge is queued.
    notify: Arc<Notify>,
    /// Count of jobs that haven't exited yet, so `has_running` is O(1) and lock-free.
    running: Arc<AtomicUsize>,
}

/// Queue a nudge and wake any idle waiter. Free function so the spawned tasks can call it with just
/// the shared handles, without borrowing the whole manager.
fn push_nudge(nudges: &std::sync::Mutex<VecDeque<String>>, notify: &Notify, msg: String) {
    nudges.lock().unwrap().push_back(msg);
    notify.notify_one();
}

impl JobManager {
    pub fn new(root: String) -> Arc<Self> {
        Arc::new(Self {
            root,
            jobs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            nudges: Arc::new(std::sync::Mutex::new(VecDeque::new())),
            notify: Arc::new(Notify::new()),
            running: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Start `command` in the background; returns its id immediately. `timeout` (if set) fires a
    /// single "still running" nudge after that long.
    ///
    /// Retained for compatibility: in-crate shell now uses `start_in` directly, but external
    /// callers may still use this convenience wrapper that delegates to `start_in` with the
    /// session root.
    #[allow(dead_code)]
    pub async fn start(&self, command: &str, timeout: Option<Duration>) -> anyhow::Result<u64> {
        self.start_in(command, timeout, &self.root).await
    }

    /// Start `command` in the background using `root` as the process cwd; returns its id
    /// immediately. `timeout` (if set) fires a single "still running" nudge after that long.
    pub async fn start_in(
        &self,
        command: &str,
        timeout: Option<Duration>,
        root: impl AsRef<Path>,
    ) -> anyhow::Result<u64> {
        let root = std::fs::canonicalize(root.as_ref())?;
        self.start_in_root(command, timeout, root).await
    }

    async fn start_in_root(
        &self,
        command: &str,
        timeout: Option<Duration>,
        root: PathBuf,
    ) -> anyhow::Result<u64> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut child = Command::new("bash")
            .arg("-lc")
            .arg(command)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()?;
        let pid = child.id().map(|p| p as i32);
        let handle = Arc::new(JobHandle {
            command: command.to_string(),
            cwd: root.clone(),
            started: Instant::now(),
            timeout,
            state: Mutex::new(JobState {
                status: JobStatus::Running,
                output: String::new(),
                pid,
            }),
        });
        self.jobs.lock().await.insert(id, handle.clone());
        self.running.fetch_add(1, Ordering::Relaxed);

        // Stream stdout + stderr into the capped buffer.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        for pipe in [stdout.map(Pipe::Out), stderr.map(Pipe::Err)]
            .into_iter()
            .flatten()
        {
            let h = handle.clone();
            tokio::spawn(async move {
                let mut reader = pipe.into_inner();
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut st = h.state.lock().await;
                            st.output.push_str(&String::from_utf8_lossy(&buf[..n]));
                            trim_to_cap(&mut st.output, OUTPUT_CAP);
                        }
                    }
                }
            });
        }

        // Wait for exit → nudge (and drop the running count).
        let name = command.chars().take(40).collect::<String>();
        let h = handle.clone();
        let nudges = self.nudges.clone();
        let notify = self.notify.clone();
        let running = self.running.clone();
        let exit_name = name.clone();
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
            let out_tail = {
                let mut st = h.state.lock().await;
                st.status = JobStatus::Exited(code);
                tail(&st.output, 20)
            };
            running.fetch_sub(1, Ordering::Relaxed);
            push_nudge(
                &nudges,
                &notify,
                format!("[job {id} `{exit_name}` finished, exit {code}]\n{out_tail}"),
            );
        });

        // Fallback timeout → one "still running" nudge.
        if let Some(t) = timeout {
            let h = handle.clone();
            let nudges = self.nudges.clone();
            let notify = self.notify.clone();
            tokio::spawn(async move {
                tokio::time::sleep(t).await;
                if matches!(h.state.lock().await.status, JobStatus::Running) {
                    push_nudge(
                        &nudges,
                        &notify,
                        format!(
                            "[job {id} `{name}` still running after {}s — job_check it or move on]",
                            t.as_secs()
                        ),
                    );
                }
            });
        }
        Ok(id)
    }

    /// Whether any job hasn't exited yet. O(1) — called on every idle loop iteration.
    pub fn has_running(&self) -> bool {
        self.running.load(Ordering::Relaxed) > 0
    }

    /// Whether any running job was started in `root`.
    pub async fn has_running_in(&self, root: &Path) -> bool {
        let Ok(root) = std::fs::canonicalize(root) else {
            return false;
        };

        let jobs = self.jobs.lock().await;
        for handle in jobs.values() {
            if handle.cwd == root && matches!(handle.state.lock().await.status, JobStatus::Running)
            {
                return true;
            }
        }
        false
    }

    /// Ready nudges (finished jobs / fired timeouts), non-blocking.
    pub fn drain_nudges(&self) -> Vec<String> {
        self.nudges.lock().unwrap().drain(..).collect()
    }

    /// Whether any nudge is queued — a cheap peek so the idle UI loop can decide to wake a turn
    /// without draining (the turn drains them itself).
    pub fn has_nudges(&self) -> bool {
        !self.nudges.lock().unwrap().is_empty()
    }

    /// Snapshot of the still-running jobs (id, command, start, timeout), for the UI activity panel.
    /// Sorted by id. Async because the job map is behind a tokio mutex.
    pub async fn running_snapshot(&self) -> Vec<JobInfo> {
        let jobs = self.jobs.lock().await;
        let mut out = Vec::new();
        for (&id, h) in jobs.iter() {
            if matches!(h.state.lock().await.status, JobStatus::Running) {
                out.push(JobInfo {
                    id,
                    command: h.command.clone(),
                    started: h.started,
                    timeout: h.timeout,
                });
            }
        }
        out.sort_by_key(|j| j.id);
        out
    }

    /// Await the next nudge (used to idle-wait when the model has nothing else to do). The notified
    /// future is armed before the queue is re-checked, so a nudge queued in the gap isn't lost.
    pub async fn next_nudge(&self) -> String {
        loop {
            let notified = self.notify.notified();
            if let Some(n) = self.nudges.lock().unwrap().pop_front() {
                return n;
            }
            notified.await;
        }
    }

    /// Resolve once a nudge is queued, WITHOUT consuming it — so a host can wake a fresh turn that
    /// then drains the nudge itself (`drain_nudges` at the turn's start). Same armed-before-check
    /// pattern as `next_nudge` so a nudge queued in the gap isn't missed. Used by the desktop host
    /// (via the lib); the CLI bin manages jobs in-turn, so it never calls this.
    #[allow(dead_code)]
    pub async fn wait_nudge(&self) {
        loop {
            let notified = self.notify.notified();
            if self.has_nudges() {
                return;
            }
            notified.await;
        }
    }

    /// Status + output tail for one job (or all).
    pub async fn check(&self, id: Option<u64>) -> String {
        let jobs = self.jobs.lock().await;
        let mut out = Vec::new();
        let mut ids: Vec<u64> = jobs.keys().copied().collect();
        ids.sort_unstable();
        for jid in ids {
            if let Some(want) = id {
                if jid != want {
                    continue;
                }
            }
            let h = &jobs[&jid];
            let st = h.state.lock().await;
            let status = match st.status {
                JobStatus::Running => "running".to_string(),
                JobStatus::Exited(c) => format!("exited {c}"),
            };
            let cmd = h.command.chars().take(60).collect::<String>();
            out.push(format!(
                "job {jid} [{status}] `{cmd}`\n{}",
                tail(&st.output, 15)
            ));
        }
        if out.is_empty() {
            "no matching jobs".to_string()
        } else {
            out.join("\n---\n")
        }
    }

    pub async fn stop(&self, id: u64) -> String {
        let jobs = self.jobs.lock().await;
        match jobs.get(&id) {
            Some(h) => {
                if let Some(pid) = h.state.lock().await.pid {
                    let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
                }
                format!("stopped job {id}")
            }
            None => format!("no job {id}"),
        }
    }

    /// The id the next started job will get. Capture before spawning a turn; anything `>=` this later
    /// was started by that turn.
    pub fn id_watermark(&self) -> u64 {
        self.next_id.load(Ordering::Relaxed)
    }

    /// SIGKILL every still-running job whose id is `>= watermark` — the jobs an interrupted turn
    /// started, without touching jobs from earlier turns.
    pub async fn kill_after(&self, watermark: u64) {
        for (id, h) in self.jobs.lock().await.iter() {
            if *id >= watermark {
                let st = h.state.lock().await;
                if matches!(st.status, JobStatus::Running) {
                    if let Some(pid) = st.pid {
                        let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
                    }
                }
            }
        }
    }

    /// Kill every still-running job (session teardown).
    pub async fn kill_all(&self) {
        for h in self.jobs.lock().await.values() {
            let st = h.state.lock().await;
            if matches!(st.status, JobStatus::Running) {
                if let Some(pid) = st.pid {
                    let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
                }
            }
        }
    }
}

/// Small helper so both pipes share one reader body.
enum Pipe {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
}
impl Pipe {
    fn into_inner(self) -> Box<dyn tokio::io::AsyncRead + Unpin + Send> {
        match self {
            Pipe::Out(o) => Box::new(o),
            Pipe::Err(e) => Box::new(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temp_dir(tag: &str) -> PathBuf {
        static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(1);

        let dir = std::env::temp_dir().join(format!(
            "agentj-jobs-{tag}-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn trim_to_cap_never_splits_a_multibyte_char() {
        // '€' is 3 bytes; 10 of them = 30 bytes. Cap 20 → over=10, which lands mid-char.
        let mut s = "€".repeat(10);
        trim_to_cap(&mut s, 20); // must not panic on the non-boundary cut
        assert!(s.len() <= 20);
        assert!(s.chars().all(|c| c == '€'));
        // The cut advanced forward to a boundary, keeping the last 6 chars (18 bytes).
        assert_eq!(s.chars().count(), 6);
    }

    #[test]
    fn trim_to_cap_is_a_noop_under_the_cap() {
        let mut s = "hello".to_string();
        trim_to_cap(&mut s, 16 * 1024);
        assert_eq!(s, "hello");
    }

    #[tokio::test]
    async fn finish_nudge_carries_output_and_exit() {
        let mgr = JobManager::new(".".to_string());
        let id = mgr.start("echo hello; exit 3", None).await.unwrap();
        // Wait for the finish nudge.
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains(&format!("job {id}")));
        assert!(nudge.contains("exit 3"));
        assert!(nudge.contains("hello"));
        assert!(!mgr.has_running());
    }

    #[tokio::test]
    async fn timeout_nudge_fires_for_a_slow_job() {
        let mgr = JobManager::new(".".to_string());
        let id = mgr
            .start("sleep 5", Some(Duration::from_millis(100)))
            .await
            .unwrap();
        // First nudge should be the timeout one (job still running).
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains("still running"));
        assert!(mgr.has_running());
        mgr.stop(id).await;
    }

    #[tokio::test]
    async fn kill_after_spares_jobs_below_the_watermark() {
        let mgr = JobManager::new(".".to_string());
        let old = mgr.start("sleep 5", None).await.unwrap();
        let watermark = mgr.id_watermark(); // captured "at turn start"
        let new = mgr.start("sleep 5", None).await.unwrap();
        assert!(new >= watermark && old < watermark);

        mgr.kill_after(watermark).await;
        // the newer job is killed; its exit nudge arrives
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains(&format!("job {new}")));
        // the older job is still running
        assert!(mgr.has_running());
        mgr.stop(old).await;
    }

    #[tokio::test]
    async fn start_in_uses_the_supplied_root() {
        let manager_root = temp_dir("manager-root");
        let job_root = temp_dir("job-root");
        let mgr = JobManager::new(manager_root.to_string_lossy().into_owned());

        let id = mgr.start_in("pwd -P", None, &job_root).await.unwrap();
        let nudge = mgr.next_nudge().await;
        let job_root = std::fs::canonicalize(job_root).unwrap();

        assert!(nudge.contains(&format!("job {id}")));
        assert!(nudge.contains(&job_root.display().to_string()));
        assert!(!nudge.contains(&manager_root.display().to_string()));

        std::fs::remove_dir_all(manager_root).unwrap();
        std::fs::remove_dir_all(job_root).unwrap();
    }

    #[tokio::test]
    async fn start_in_rejects_a_missing_root_before_consuming_an_id() {
        let mgr = JobManager::new(".".to_string());
        let missing = std::env::temp_dir().join(format!(
            "agentj-jobs-missing-root-{}-{}",
            std::process::id(),
            mgr.id_watermark()
        ));

        let err = mgr.start_in("pwd -P", None, &missing).await.unwrap_err();

        assert!(err.downcast_ref::<std::io::Error>().is_some());
        assert_eq!(mgr.id_watermark(), 1);
        assert!(!mgr.has_running());
    }

    #[tokio::test]
    async fn has_running_in_matches_canonical_roots_only_while_running() {
        let manager_root = temp_dir("manager-root");
        let root_a = temp_dir("root-a");
        let root_b = temp_dir("root-b");
        let alias_parent = temp_dir("root-a-alias-parent");
        let alias_a = alias_parent.join("alias-a");
        symlink(&root_a, &alias_a).unwrap();

        let mgr = JobManager::new(manager_root.to_string_lossy().into_owned());
        let id = mgr.start_in("sleep 5", None, &root_a).await.unwrap();

        assert!(mgr.has_running_in(&root_a).await);
        assert!(!mgr.has_running_in(&root_b).await);
        assert!(mgr.has_running_in(&alias_a).await);

        assert_eq!(mgr.stop(id).await, format!("stopped job {id}"));
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains(&format!("job {id}")));
        assert!(!mgr.has_running_in(&root_a).await);

        std::fs::remove_dir_all(manager_root).unwrap();
        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
        std::fs::remove_dir_all(alias_parent).unwrap();
    }
}
