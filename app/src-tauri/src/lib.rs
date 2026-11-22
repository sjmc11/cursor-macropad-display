mod device;
mod files;

use device::{
    device_detect, device_play_frames, device_probe_slots, device_program, device_set_lighting,
    device_state, start_hotplug_poll,
};
use files::{
    check_bridge, check_extension_installed, delete_file, get_project_root, list_files,
    read_cursor_keybindings, read_file, write_cursor_keybindings, write_file,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_project_root,
            read_file,
            write_file,
            list_files,
            delete_file,
            read_cursor_keybindings,
            write_cursor_keybindings,
            check_bridge,
            check_extension_installed,
            device_detect,
            device_state,
            device_program,
            device_probe_slots,
            device_set_lighting,
            device_play_frames,
        ])
        .setup(|app| {
            files::start_watcher(app.handle().clone());
            start_hotplug_poll(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
