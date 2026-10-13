//! rupbar-service: mantém o servidor local do RupBar em execução.
//!
//!   rupbar-service install     instala e inicia o serviço do Windows (admin)
//!   rupbar-service uninstall   remove o serviço (dados preservados)
//!   rupbar-service run         ponto de entrada usado pelo Windows (SCM)
//!   rupbar-service console     executa em primeiro plano (depuração)

mod supervisor;
#[cfg(windows)]
mod winsvc;

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "console".into());
    let result = match cmd.as_str() {
        "--version" | "-V" => {
            println!("rupbar-service {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        #[cfg(windows)]
        "install" => winsvc::install(),
        #[cfg(windows)]
        "uninstall" => winsvc::uninstall(),
        #[cfg(windows)]
        "run" => winsvc::run_service(),
        "console" => supervisor::run_console(),
        other => Err(format!("comando desconhecido: {other}. Use install, uninstall, run ou console.")),
    };
    if let Err(e) = result {
        eprintln!("rupbar-service: {e}");
        std::process::exit(1);
    }
}
