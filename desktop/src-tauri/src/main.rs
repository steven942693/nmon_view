#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[tauri::command]
async fn load_nmon(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || nmon_core::load_file(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("解析任务失败：{e}"))?
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_nmon])
        .run(tauri::generate_context!())
        .expect("桌面应用启动失败");
}
