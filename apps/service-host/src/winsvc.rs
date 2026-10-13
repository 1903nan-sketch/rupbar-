//! Integração com o Gerenciador de Serviços do Windows (SCM).

use std::ffi::OsString;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
    ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

use crate::supervisor::{data_dir, Config, Supervisor, DEFAULT_PORT};

pub const SERVICE_NAME: &str = "RupBarServer";
const DISPLAY_NAME: &str = "RupBar Server";
const DESCRIPTION: &str = "Servidor local do RupBar (Ruptix): comandas, pedidos, impressão, TV e sincronização. Mantém celulares e TV funcionando mesmo com a janela fechada.";

define_windows_service!(ffi_service_main, service_main);

pub fn run_service() -> Result<(), String> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|e| e.to_string())
}

fn service_main(_args: Vec<OsString>) {
    let cfg = match Config::discover() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    let sup: Arc<Supervisor> = Supervisor::new(cfg);
    let handler_sup = sup.clone();
    let handler = move |control| -> ServiceControlHandlerResult {
        match control {
            ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                handler_sup.request_stop();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status = match service_control_handler::register(SERVICE_NAME, handler) {
        Ok(s) => s,
        Err(e) => {
            sup.log(&format!("falha ao registrar o serviço: {e}"));
            return;
        }
    };
    let running = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };
    let _ = status.set_service_status(running.clone());
    sup.run();
    let _ = status.set_service_status(ServiceStatus {
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        ..running
    });
}

fn run(cmd: &str, args: &[&str]) {
    let _ = Command::new(cmd).args(args).status();
}

/// Instala (ou reinstala) o serviço, regras de firewall e permissões da pasta de dados.
pub fn install() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)
        .map_err(|e| format!("execute como administrador: {e}"))?;

    // Reinstalação/atualização: remove a definição anterior.
    if let Ok(old) = manager.open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS) {
        let _ = old.stop();
        std::thread::sleep(Duration::from_secs(3));
        let _ = old.delete();
        std::thread::sleep(Duration::from_secs(1));
    }

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe,
        launch_arguments: vec![OsString::from("run")],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };
    let service = manager
        .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS)
        .map_err(|e| format!("não foi possível criar o serviço: {e}"))?;
    let _ = service.set_description(DESCRIPTION);
    // Recuperação automática: reinicia o serviço se ele falhar.
    let _ = service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 3600)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(5) },
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(15) },
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(60) },
        ]),
    });
    let _ = service.set_failure_actions_on_non_crash_failures(true);

    // Pasta de dados: apenas SYSTEM e Administradores (protege banco e chave mestra).
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let dir_s = dir.to_string_lossy().to_string();
    run("icacls", &[&dir_s, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);

    // Firewall: libera a porta do RupBar e o mDNS apenas em redes privadas/domínio.
    let port = DEFAULT_PORT.to_string();
    run("netsh", &["advfirewall", "firewall", "delete", "rule", "name=RupBar Server"]);
    run("netsh", &["advfirewall", "firewall", "add", "rule", "name=RupBar Server", "dir=in", "action=allow", "protocol=TCP", &format!("localport={port}"), "profile=private,domain"]);
    run("netsh", &["advfirewall", "firewall", "delete", "rule", "name=RupBar mDNS"]);
    run("netsh", &["advfirewall", "firewall", "add", "rule", "name=RupBar mDNS", "dir=in", "action=allow", "protocol=UDP", "localport=5353", "profile=private,domain"]);

    service.start(&[] as &[&OsString]).map_err(|e| format!("serviço criado, mas não iniciou: {e}"))?;
    println!("Serviço {SERVICE_NAME} instalado e iniciado.");
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).map_err(|e| e.to_string())?;
    if let Ok(service) = manager.open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS) {
        let _ = service.stop();
        for _ in 0..30 {
            match service.query_status() {
                Ok(s) if s.current_state == ServiceState::Stopped => break,
                _ => std::thread::sleep(Duration::from_millis(500)),
            }
        }
        service.delete().map_err(|e| e.to_string())?;
    }
    run("netsh", &["advfirewall", "firewall", "delete", "rule", "name=RupBar Server"]);
    run("netsh", &["advfirewall", "firewall", "delete", "rule", "name=RupBar mDNS"]);
    println!("Serviço {SERVICE_NAME} removido. Os dados em {} foram preservados.", data_dir().display());
    Ok(())
}
