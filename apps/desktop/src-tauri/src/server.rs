//! Comunicação com o servidor local: verificação de saúde e inicialização.
//!
//! Em produção o servidor roda como serviço do Windows ("RupBarServer").
//! Se o serviço não estiver instalado (modo portátil/desenvolvimento), a janela
//! inicia o supervisor como processo filho e o encerra ao sair.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

pub const PORT: u16 = 7420;

pub fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}/")
}

#[derive(serde::Serialize)]
pub struct Status {
    pub ok: bool,
    pub url: String,
    pub configured: bool,
}

/// GET /api/health com timeout curto, sem dependências HTTP externas.
pub fn health() -> Status {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    let mut ok = false;
    let mut configured = false;
    if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
        let req = format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n");
        if s.write_all(req.as_bytes()).is_ok() {
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            ok = buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200");
            ok = ok && buf.contains("\"app\":\"rupbar\"");
            configured = buf.contains("\"configured\":true");
        }
    }
    Status { ok, url: base_url(), configured }
}

#[derive(Default)]
pub struct Sidecar(pub Mutex<Option<Child>>);

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

#[cfg(windows)]
fn service_installed() -> bool {
    hidden(&mut Command::new("sc")).args(["query", "RupBarServer"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(not(windows))]
fn service_installed() -> bool {
    false
}

fn portable_data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("RupBar")
}

/// Garante que o servidor está no ar. Retorna "running", "service" ou "sidecar".
pub fn ensure(resource_dir: Option<PathBuf>, sidecar: &Sidecar) -> Result<String, String> {
    if health().ok {
        return Ok("running".into());
    }
    if service_installed() {
        let _ = hidden(&mut Command::new("sc")).args(["start", "RupBarServer"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        return Ok("service".into());
    }
    let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if let Ok(None) = child.try_wait() {
            return Ok("sidecar".into());
        }
    }
    let dir = resource_dir.ok_or("pasta de recursos não encontrada")?;
    let exe = dir.join(if cfg!(windows) { "rupbar-service.exe" } else { "rupbar-service" });
    let child = hidden(&mut Command::new(&exe))
        .arg("console")
        .env("RUPBAR_DATA_DIR", portable_data_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("não foi possível iniciar {}: {e}", exe.display()))?;
    *guard = Some(child);
    Ok("sidecar".into())
}

/// Encerra o servidor iniciado pela janela (o serviço do Windows não é afetado).
pub fn stop_sidecar(sidecar: &Sidecar) {
    if let Ok(mut guard) = sidecar.0.lock() {
        if let Some(mut child) = guard.take() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(b"\n");
            }
            for _ in 0..50 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let _ = child.kill();
        }
    }
}

/// Abre um endereço no navegador padrão do sistema.
pub fn open_in_browser(url: &str) {
    #[cfg(windows)]
    {
        let _ = hidden(&mut Command::new("cmd")).args(["/C", "start", "", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}
