//! Aplicativo Windows do RupBar.
//!
//! A janela é apenas uma interface: o servidor local roda como serviço do
//! Windows, então fechar a janela não derruba celulares, cozinha nem TV.
//! Fechar a janela a esconde na bandeja; "Sair" encerra só a interface.

mod server;

use server::{Sidecar, Status};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[tauri::command]
fn server_status() -> Status {
    server::health()
}

#[tauri::command]
fn ensure_server(app: AppHandle) -> Result<String, String> {
    let dir = app.path().resource_dir().ok();
    server::ensure(dir, app.state::<Sidecar>().inner())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Recarrega a interface pelo endereço com marca de tempo (não usa a tela guardada).
fn reload_ui(app: &AppHandle) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    navigate(app, &format!("?v={stamp}"));
}

fn navigate(app: &AppHandle, path: &str) {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(url) = format!("{}{}", server::base_url(), path.trim_start_matches('/')).parse() {
            let _ = w.navigate(url);
        }
    }
    show_main(app);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![server_status, ensure_server])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Abrir RupBar", true, None::<&str>)?;
            let devices = MenuItem::with_id(app, "devices", "Conectar celular (QR Code)", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Recarregar a tela", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "Abrir no navegador", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair da janela", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &reload, &devices, &browser, &sep, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("RupBar — servidor ativo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "reload" => reload_ui(app),
                    "devices" => navigate(app, "configuracoes/dispositivos"),
                    "browser" => server::open_in_browser(&server::base_url()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fechar a janela esconde na bandeja: o servidor continua atendendo a rede.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o RupBar")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                server::stop_sidecar(app.state::<Sidecar>().inner());
            }
        });
}
