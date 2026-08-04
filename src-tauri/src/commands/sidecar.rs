// ================================================================
//  commands/sidecar.rs — Node sidecar process management + JSON-RPC
//
//  Responsibilities:
//    * spawn the Node sidecar (command path configurable via
//      FLOWFORGE_SIDECAR_CMD; packaged apps load the bundled
//      `sidecar/dist/index.js` resource, dev falls back to the repo
//      build output or tsx on the TS source)
//    * forward requests over stdin/stdout JSON-RPC 2.0, routing
//      responses back by id (pending map + oneshot channels)
//    * re-emit sidecar notifications (messages without id) to the
//      webview as the `sidecar://event` Tauri event
//    * 10s heartbeat (ping); kill + restart on 3 consecutive misses
//    * crash auto-restart with exponential backoff and max retries
//    * kill the child on app exit
// ================================================================

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Graph indexing (graph_engine.index_repo / index_cross_repo) can run
/// for many minutes on large repos; the generic 30s budget would kill
/// the request while the sidecar keeps working — give these a wider
/// window matching the sidecar's own 10-minute call timeout.
const LONG_REQUEST_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HEARTBEAT_MISSES: u32 = 3;
const MAX_RESTARTS: u32 = 5;
/// A child that stays alive this long is considered healthy: the
/// restart counter resets so transient crashes don't accumulate.
const STABLE_UPTIME: Duration = Duration::from_secs(60);

pub const EVENT_CHANNEL: &str = "sidecar://event";

type Pending = Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Starting,
    Running,
    Restarting,
    Failed,
    Stopped,
}

struct StatusInner {
    state: RunState,
    pid: Option<u32>,
    restarts: u32,
    last_error: Option<String>,
}

pub struct SidecarManager {
    pending: Pending,
    stdin: Mutex<Option<ChildStdin>>,
    status: Mutex<StatusInner>,
    shutting_down: AtomicBool,
    /// generation guard: bumped on every (re)spawn so stale heartbeat
    /// tasks from a previous child exit cleanly
    generation: AtomicU64,
    internal_seq: AtomicU64,
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            status: Mutex::new(StatusInner {
                state: RunState::Stopped,
                pid: None,
                restarts: 0,
                last_error: None,
            }),
            shutting_down: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            internal_seq: AtomicU64::new(0),
        }
    }
}

// ─── Command resolution ─────────────────────────────────────────

/// Locate the Node executable: FLOWFORGE_NODE override first, then a
/// PATH scan for `node` (`node.exe` on Windows), then well-known
/// install locations. tokio's Command does not use the shell, so the
/// explicit lookup keeps Windows working. The fallback probing matters
/// for macOS GUI apps: launchd hands the app a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), so nvm/Homebrew installs are
/// invisible without it.
fn resolve_node() -> Result<String, String> {
    if let Ok(node) = std::env::var("FLOWFORGE_NODE") {
        if !node.trim().is_empty() {
            return Ok(node);
        }
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    // Fallback probes: nvm (pick the newest installed version),
    // Homebrew (Apple Silicon + Intel), MacPorts, system install.
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let nvm_root = std::path::Path::new(&home)
                .join(".nvm")
                .join("versions")
                .join("node");
            if let Ok(entries) = std::fs::read_dir(&nvm_root) {
                let mut versions: Vec<std::path::PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.join("bin").join("node").is_file())
                    .collect();
                // "v24.13.1" style names sort correctly as text for
                // typical single/double-digit majors; sort then take last.
                versions.sort();
                if let Some(newest) = versions.pop() {
                    let node = newest.join("bin").join("node");
                    log::info!("[sidecar] node resolved via nvm: {}", node.display());
                    return Ok(node.to_string_lossy().into_owned());
                }
            }
        }
        for candidate in [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/opt/local/bin/node",
            "/usr/bin/node",
        ] {
            if std::path::Path::new(candidate).is_file() {
                return Ok(candidate.to_string());
            }
        }
    }
    #[cfg(windows)]
    {
        for candidate in [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ] {
            if std::path::Path::new(candidate).is_file() {
                return Ok(candidate.to_string());
            }
        }
    }
    Err(format!(
        "`{exe}` not found on PATH or common install locations — install Node.js >= 20 or set FLOWFORGE_NODE to the executable path"
    ))
}

/// Split a command line on whitespace, honouring double quotes so
/// segments with embedded spaces (e.g. `"C:\Program Files\nodejs\node.exe"`)
/// stay intact; the quotes themselves are stripped. Without quotes the
/// result is identical to a plain `split_whitespace`.
fn split_command_line(cmd: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in cmd.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Resolve the sidecar launch command.
/// Priority: FLOWFORGE_SIDECAR_CMD (quote-aware whitespace-split;
/// wrap paths containing spaces in double quotes) always wins.
/// Packaged (release) builds load `sidecar/dist/index.js` from the
/// Tauri resource dir and run it with the bundled Node binary
/// (`bin/node` resource, fetched by scripts/fetch-node.mjs) so the
/// app needs no system Node; falls back to system lookup when the
/// bundled runtime is absent. Dev (debug) builds keep the repo-relative
/// defaults: built output first, then tsx on the TS source.
fn resolve_command<R: Runtime>(app: &AppHandle<R>) -> Result<(String, Vec<String>), String> {
    if let Ok(cmd) = std::env::var("FLOWFORGE_SIDECAR_CMD") {
        let mut parts = split_command_line(&cmd).into_iter();
        let program = parts
            .next()
            .ok_or_else(|| "FLOWFORGE_SIDECAR_CMD is empty".to_string())?;
        return Ok((program, parts.collect()));
    }

    if !cfg!(debug_assertions) {
        // packaged app: the built sidecar ships as a bundle resource
        let resource = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource dir unavailable: {e}"))?
            .join("sidecar")
            .join("dist")
            .join("index.js");
        if resource.exists() {
            // Prefer the bundled Node runtime (zero external deps);
            // fall back to system node when it was not packaged.
            let bundled = app
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join("bin").join(if cfg!(windows) { "node.exe" } else { "node" }));
            let node = match bundled.filter(|p| p.is_file()) {
                Some(p) => p.to_string_lossy().into_owned(),
                None => resolve_node()?,
            };
            return Ok((node, vec![resource.to_string_lossy().into_owned()]));
        }
        return Err(format!(
            "packaged sidecar not found at `{}` — the bundle is missing its sidecar/dist resource; reinstall the app or set FLOWFORGE_SIDECAR_CMD",
            resource.display()
        ));
    }

    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let built = repo_root.join("sidecar").join("dist").join("index.js");
    if built.exists() {
        return Ok((resolve_node()?, vec![built.to_string_lossy().into_owned()]));
    }
    let source = repo_root.join("sidecar").join("src").join("index.ts");
    if source.exists() {
        let npx = if cfg!(windows) { "npx.cmd" } else { "npx" };
        return Ok((
            npx.into(),
            vec!["tsx".into(), source.to_string_lossy().into_owned()],
        ));
    }
    Err("sidecar entry not found: set FLOWFORGE_SIDECAR_CMD or build sidecar/".into())
}

// ─── Supervisor loop ────────────────────────────────────────────

/// Spawn the supervisor task: starts the sidecar, restarts it with
/// exponential backoff on crash, gives up after MAX_RESTARTS.
pub fn spawn_supervisor<R: Runtime>(app: AppHandle<R>, manager: Arc<SidecarManager>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if manager.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            let (program, args) = match resolve_command(&app) {
                Ok(cmd) => cmd,
                Err(e) => {
                    log::error!("[sidecar] {e}");
                    manager.set_failed(e).await;
                    break;
                }
            };

            manager.set_state(RunState::Starting).await;
            let started_at = Instant::now();

            match spawn_child(&program, &args) {
                Ok(child) => {
                    log::info!("[sidecar] started: {program} {args:?} pid={:?}", child.id());
                    run_child(&app, &manager, child).await;
                }
                Err(e) => {
                    log::error!("[sidecar] spawn failed: {e}");
                    manager.status.lock().await.last_error = Some(e);
                }
            }

            if manager.shutting_down.load(Ordering::SeqCst) {
                manager.set_state(RunState::Stopped).await;
                break;
            }

            // crash path: backoff + retry budget
            let restarts = {
                let mut st = manager.status.lock().await;
                if started_at.elapsed() >= STABLE_UPTIME {
                    st.restarts = 0; // was healthy long enough — fresh budget
                }
                st.restarts += 1;
                st.pid = None;
                st.state = RunState::Restarting;
                st.restarts
            };
            if restarts > MAX_RESTARTS {
                manager
                    .set_failed(format!("sidecar crashed {MAX_RESTARTS} times, giving up"))
                    .await;
                let _ = app.emit(EVENT_CHANNEL, json!({ "method": "sidecar/failed", "params": {} }));
                break;
            }
            let delay = Duration::from_secs(1 << restarts.min(5)); // 2,4,8,16,32s
            log::warn!("[sidecar] restart #{restarts} in {delay:?}");
            tokio::time::sleep(delay).await;
        }
    });
}

fn spawn_child(program: &str, args: &[String]) -> Result<Child, String> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))
}

/// Drive one child lifetime: stdout routing + heartbeat until it exits.
async fn run_child<R: Runtime>(app: &AppHandle<R>, manager: &Arc<SidecarManager>, mut child: Child) {
    let generation_id = manager.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let stdout = child.stdout.take().expect("child stdout is piped");
    *manager.stdin.lock().await = child.stdin.take();
    {
        let mut st = manager.status.lock().await;
        st.state = RunState::Running;
        st.pid = child.id();
        st.last_error = None;
    }

    // heartbeat task (stops when generation moves on)
    {
        let manager = Arc::clone(manager);
        tauri::async_runtime::spawn(async move {
            let mut misses = 0u32;
            loop {
                tokio::time::sleep(HEARTBEAT_INTERVAL).await;
                if manager.generation.load(Ordering::SeqCst) != generation_id
                    || manager.shutting_down.load(Ordering::SeqCst)
                {
                    break;
                }
                let seq = manager.internal_seq.fetch_add(1, Ordering::SeqCst);
                let ok = manager
                    .request_with_timeout(format!("hb_{seq}"), "ping", json!({}), HEARTBEAT_TIMEOUT)
                    .await
                    .is_ok();
                if ok {
                    misses = 0;
                    manager.status.lock().await.restarts = 0;
                } else {
                    misses += 1;
                    log::warn!("[sidecar] heartbeat miss {misses}/{MAX_HEARTBEAT_MISSES}");
                    if misses >= MAX_HEARTBEAT_MISSES {
                        manager.status.lock().await.last_error =
                            Some("heartbeat lost".into());
                        // dropping stdin closes the pipe; the child is
                        // additionally killed by the supervisor below
                        manager.stdin.lock().await.take();
                        break;
                    }
                }
            }
        });
    }

    // stdout routing loop — ends when the pipe closes (child exited)
    let mut lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => route_line(app, manager, &line).await,
                    Ok(None) => break,          // EOF
                    Err(e) => { log::warn!("[sidecar] stdout read error: {e}"); break; }
                }
            }
            // heartbeat gave up and closed stdin → force kill
            _ = async {
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if manager.stdin.lock().await.is_none() { break; }
                }
            } => {
                let _ = child.kill().await;
                break;
            }
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    manager.stdin.lock().await.take();
    manager.fail_all_pending("sidecar exited").await;
    log::warn!("[sidecar] process exited (gen {generation_id})");
}

/// Route one stdout line: response (has id) → pending map;
/// notification (no id) → `sidecar://event`.
async fn route_line<R: Runtime>(app: &AppHandle<R>, manager: &SidecarManager, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            log::debug!("[sidecar] non-JSON stdout line ignored: {line}");
            return;
        }
    };

    match msg.get("id").and_then(|v| v.as_str()) {
        Some(id) => {
            let sender = manager.pending.lock().await.remove(id);
            if let Some(tx) = sender {
                let outcome = if let Some(err) = msg.get("error") {
                    Err(err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("sidecar error")
                        .to_string())
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            } else {
                log::debug!("[sidecar] response for unknown id {id}");
            }
        }
        None => {
            // JSON-RPC notification → stream event for the webview
            if msg.get("method").is_some() {
                let _ = app.emit(EVENT_CHANNEL, msg);
            }
        }
    }
}

// ─── Manager internals ──────────────────────────────────────────

impl SidecarManager {
    async fn set_state(&self, state: RunState) {
        self.status.lock().await.state = state;
    }

    async fn set_failed(&self, err: String) {
        let mut st = self.status.lock().await;
        st.state = RunState::Failed;
        st.pid = None;
        st.last_error = Some(err);
    }

    async fn fail_all_pending(&self, reason: &str) {
        let mut pending = self.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(reason.to_string()));
        }
    }

    /// Write a JSON-RPC request and await its routed response.
    async fn request_with_timeout(
        &self,
        id: String,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut line = payload.to_string();
        line.push('\n');

        let write_result = {
            let mut guard = self.stdin.lock().await;
            match guard.as_mut() {
                Some(stdin) => match stdin.write_all(line.as_bytes()).await {
                    Ok(()) => stdin
                        .flush()
                        .await
                        .map_err(|e| format!("stdin flush failed: {e}")),
                    Err(e) => Err(format!("stdin write failed: {e}")),
                },
                None => Err("sidecar is not running".to_string()),
            }
        };
        if let Err(e) = write_result {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("sidecar response channel closed".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("sidecar request `{method}` timed out"))
            }
        }
    }
}

// ─── Tauri commands ─────────────────────────────────────────────

/// Forward a JSON-RPC request from the webview to the sidecar.
/// `id` comes from SidecarBridge (unique per request) and is used to
/// route the matching response back through the pending map.
#[tauri::command]
pub async fn sidecar_request(
    id: String,
    method: String,
    params: Value,
    manager: State<'_, Arc<SidecarManager>>,
) -> Result<Value, String> {
    // long-running graph indexing gets the extended budget
    let timeout = if method.starts_with("graph_engine.index") {
        LONG_REQUEST_TIMEOUT
    } else {
        REQUEST_TIMEOUT
    };
    manager
        .request_with_timeout(id, &method, params, timeout)
        .await
}

/// Current sidecar run state for diagnostics / the frontend context.
#[tauri::command]
pub async fn sidecar_status(manager: State<'_, Arc<SidecarManager>>) -> Result<Value, String> {
    let st = manager.status.lock().await;
    Ok(json!({
        "state": st.state,
        "pid": st.pid,
        "restarts": st.restarts,
        "lastError": st.last_error,
    }))
}

/// Called from the app exit hook: stop the supervisor loop and close
/// stdin so the child terminates (kill_on_drop covers the rest).
pub fn shutdown(manager: &Arc<SidecarManager>) {
    manager.shutting_down.store(true, Ordering::SeqCst);
    let manager = Arc::clone(manager);
    tauri::async_runtime::spawn(async move {
        manager.stdin.lock().await.take();
        manager.fail_all_pending("app is shutting down").await;
        manager.set_state(RunState::Stopped).await;
    });
}

#[cfg(test)]
mod tests {
    use super::split_command_line;

    #[test]
    fn split_command_line_plain_matches_split_whitespace() {
        assert_eq!(
            split_command_line("node  /opt/app/sidecar/dist/index.js --flag"),
            vec!["node", "/opt/app/sidecar/dist/index.js", "--flag"]
        );
        assert!(split_command_line("   ").is_empty());
    }

    #[test]
    fn split_command_line_keeps_quoted_paths_with_spaces() {
        assert_eq!(
            split_command_line(
                r#""C:\Program Files\nodejs\node.exe" C:\app\sidecar\dist\index.js"#
            ),
            vec![
                r"C:\Program Files\nodejs\node.exe",
                r"C:\app\sidecar\dist\index.js"
            ]
        );
    }
}
