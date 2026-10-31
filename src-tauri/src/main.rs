#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod linux_fonts;

fn main() {
    // Before any GTK/WebKit init (Linux emoji freeze, issue #179).
    #[cfg(target_os = "linux")]
    linux_fonts::hide_colrv1_fonts();
    // First, while single-threaded: agents and tools inherit a PATH that finds `gh`, `node`…
    pandacode_lib::prepare_environment();
    if pandacode_lib::handle_usage_keychain_helper() {
        return;
    }
    // A cloud agent's bridge to its machine (docs/cloud-agents.md); exits when done.
    if pandacode_lib::handle_cloud_bridge() {
        return;
    }
    // The headless host (docs/headless.md): `pandacode serve` never returns on its own.
    if pandacode_lib::handle_serve() {
        return;
    }
    pandacode_lib::run()
}
