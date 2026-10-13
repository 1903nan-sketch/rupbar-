//! Supervisor multiplataforma do processo Node do servidor local.
//!
//! - Inicia `node server.cjs` com o diretório de dados e a porta.
//! - Reinicia com backoff exponencial se o processo cair (máx. 30 s);
//!   o contador zera após 60 s de funcionamento estável.
//! - Encerramento gracioso: envia "shutdown" pelo stdin (no Windows não há
//!   SIGTERM), aguarda até 10 s e só então força o término.
//! - Saída do servidor vai para `logs/service.log` com rotação simples.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 7420;
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct Config {
    pub node: PathBuf,
    pub server_js: PathBuf,
    pub ui_dir: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub port: u16,
}

impl Config {
    /// Descobre os caminhos a partir da pasta do executável.
    pub fn discover() -> Result<Config, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let base = exe.parent().ok_or("pasta do executável inválida")?.to_path_buf();
        let candidates = [
            base.join("server"),
            base.join("resources").join("server"),
            base.join("..").join("server"),
            base.join("..").join("..").join("server").join("dist"),
        ];
        let server_dir = candidates
            .iter()
            .find(|d| d.join("server.cjs").exists())
            .cloned()
            .ok_or_else(|| format!("server.cjs não encontrado perto de {}", base.display()))?;
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let bundled = server_dir.join(node_name);
        let node = if bundled.exists() { bundled } else { PathBuf::from(node_name) };
        let ui = server_dir.join("public");
        let port = std::env::var("RUPBAR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
        Ok(Config {
            node,
            server_js: server_dir.join("server.cjs"),
            ui_dir: if ui.join("index.html").exists() { Some(ui) } else { None },
            data_dir: data_dir(),
            port,
        })
    }
}

/// %ProgramData%\RupBar no Windows; ~/.rupbar nos demais sistemas.
pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("RUPBAR_DATA_DIR") {
        return PathBuf::from(d);
    }
    if cfg!(windows) {
        let pd = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        PathBuf::from(pd).join("RupBar")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".rupbar")
    }
}

pub struct Supervisor {
    cfg: Config,
    stop: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Supervisor {
    pub fn new(cfg: Config) -> Arc<Supervisor> {
        Arc::new(Supervisor { cfg, stop: AtomicBool::new(false), child: Mutex::new(None) })
    }

    fn log_file(&self) -> Option<File> {
        let dir = self.cfg.data_dir.join("logs");
        fs::create_dir_all(&dir).ok()?;
        let path = dir.join("service.log");
        if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
            let _ = fs::rename(&path, dir.join("service.log.1"));
        }
        OpenOptions::new().create(true).append(true).open(path).ok()
    }

    pub fn log(&self, msg: &str) {
        if let Some(mut f) = self.log_file() {
            let _ = writeln!(f, "[supervisor {}] {}", unix_time(), msg);
        }
        eprintln!("[rupbar-service] {msg}");
    }

    fn spawn(&self) -> std::io::Result<Child> {
        let out = self.log_file();
        let err = self.log_file();
        let mut cmd = Command::new(&self.cfg.node);
        cmd.arg("--disable-warning=ExperimentalWarning")
            .arg(&self.cfg.server_js)
            .arg("--data-dir")
            .arg(&self.cfg.data_dir)
            .arg("--port")
            .arg(self.cfg.port.to_string())
            .env("NODE_ENV", "production")
            .stdin(Stdio::piped())
            .stdout(out.map(Stdio::from).unwrap_or_else(Stdio::null))
            .stderr(err.map(Stdio::from).unwrap_or_else(Stdio::null));
        if let Some(ui) = &self.cfg.ui_dir {
            cmd.arg("--ui-dir").arg(ui);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.spawn()
    }

    /// Bloqueia até `request_stop`, mantendo o servidor no ar.
    pub fn run(&self) {
        let _ = fs::create_dir_all(&self.cfg.data_dir);
        let mut attempt: u32 = 0;
        while !self.stop.load(Ordering::SeqCst) {
            let started = Instant::now();
            match self.spawn() {
                Ok(child) => {
                    self.log(&format!("servidor iniciado (pid {}) na porta {}", child.id(), self.cfg.port));
                    *self.child.lock().unwrap() = Some(child);
                    let status = loop {
                        if self.stop.load(Ordering::SeqCst) {
                            break None;
                        }
                        let mut guard = self.child.lock().unwrap();
                        match guard.as_mut().map(|c| c.try_wait()) {
                            Some(Ok(Some(st))) => {
                                guard.take();
                                break Some(st);
                            }
                            Some(Ok(None)) => {}
                            _ => break None,
                        }
                        drop(guard);
                        thread::sleep(Duration::from_millis(500));
                    };
                    if let Some(st) = status {
                        self.log(&format!("servidor terminou inesperadamente: {st}"));
                    }
                }
                Err(e) => self.log(&format!("falha ao iniciar o servidor ({}): {e}", self.cfg.node.display())),
            }
            if self.stop.load(Ordering::SeqCst) {
                break;
            }
            if started.elapsed() > Duration::from_secs(60) {
                attempt = 0;
            }
            attempt = attempt.saturating_add(1);
            let wait = Duration::from_millis((1000u64 << attempt.min(5)).min(30_000));
            self.log(&format!("reiniciando em {} s (tentativa {attempt})", wait.as_secs()));
            let until = Instant::now() + wait;
            while Instant::now() < until && !self.stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(200));
            }
        }
        self.shutdown_child();
        self.log("supervisor encerrado");
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn shutdown_child(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(b"shutdown\n");
                let _ = stdin.flush();
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    self.log("servidor encerrado com sucesso");
                    return;
                }
                thread::sleep(Duration::from_millis(200));
            }
            self.log("servidor não respondeu; forçando término");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn unix_time() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Executa em primeiro plano (desenvolvimento, Linux/macOS ou depuração).
pub fn run_console() -> Result<(), String> {
    let cfg = Config::discover()?;
    let sup = Supervisor::new(cfg);
    let s2 = sup.clone();
    thread::spawn(move || {
        // Enter/EOF no terminal encerra de forma graciosa.
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        s2.request_stop();
    });
    sup.run();
    Ok(())
}

#[allow(dead_code)]
pub fn exists(p: &Path) -> bool {
    p.exists()
}
