#[allow(dead_code)]
pub mod protocol;

use protocol::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Global lock preventing interleaved HID writes (programming, lighting, frames).
static DEVICE_LOCK: Mutex<()> = Mutex::new(());

/// Information about a connected macropad.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub serial: String,
    pub connected: bool,
}

/// Result of programming the pad.
#[derive(Debug, Clone, Serialize)]
pub struct ProgramResult {
    pub keys_written: usize,
    pub knobs_written: usize,
    pub leds_written: usize,
    pub saved: bool,
}

/// The last known state of what was programmed, so we can diff.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeviceState {
    pub bindings: Vec<KeyBinding>,
    pub lighting: Vec<LayerLighting>,
    pub programmed_at: Option<String>,
}

fn state_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".macropad/device-state.json")
}

pub fn load_device_state() -> DeviceState {
    match fs::read_to_string(state_path()) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => DeviceState::default(),
    }
}

pub fn save_device_state(state: &DeviceState) -> Result<(), String> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Find the macropad among connected HID devices.
fn find_device() -> Result<DeviceInfo, String> {
    let api = hidapi::HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;

    for dev in api.device_list() {
        let vid = dev.vendor_id();
        let pid = dev.product_id();

        if !VENDOR_IDS.contains(&vid) || !PRODUCT_IDS.contains(&pid) {
            continue;
        }

        // We want the vendor-defined interface (usage page 0xFF00), not the keyboard interface.
        if dev.usage_page() != 0xFF00 {
            continue;
        }

        return Ok(DeviceInfo {
            vendor_id: vid,
            product_id: pid,
            product_name: dev.product_string().unwrap_or("Macropad").to_string(),
            serial: dev.serial_number().unwrap_or("").to_string(),
            connected: true,
        });
    }

    Err("Macropad not found. Make sure it is plugged in via USB.".into())
}

/// Open the vendor HID interface for writing.
fn open_device() -> Result<hidapi::HidDevice, String> {
    let api = hidapi::HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;

    for dev_info in api.device_list() {
        let vid = dev_info.vendor_id();
        let pid = dev_info.product_id();

        if !VENDOR_IDS.contains(&vid) || !PRODUCT_IDS.contains(&pid) {
            continue;
        }
        if dev_info.usage_page() != 0xFF00 {
            continue;
        }

        let device = dev_info.open_device(&api).map_err(|e| {
            format!(
                "Failed to open device: {e}. You may need to grant Input Monitoring permission."
            )
        })?;

        return Ok(device);
    }

    Err("Macropad not found. Make sure it is plugged in via USB.".into())
}

/// Send a 64-byte message to the device. Byte 0 is already the report ID.
fn send_report(device: &hidapi::HidDevice, report: &[u8; REPORT_SIZE]) -> Result<(), String> {
    // The output report is 1 ID byte + 64 data bytes; pad the 64-byte message to fit.
    let mut buf = [0u8; REPORT_SIZE + 1];
    buf[..REPORT_SIZE].copy_from_slice(report);

    device
        .write(&buf)
        .map_err(|e| format!("Write failed: {e}"))?;

    // Small delay between reports to avoid overwhelming the pad's firmware.
    std::thread::sleep(std::time::Duration::from_millis(10));

    Ok(())
}

// ---- Tauri commands ----

#[tauri::command]
pub fn device_detect() -> DeviceInfo {
    match find_device() {
        Ok(info) => info,
        Err(_) => DeviceInfo {
            vendor_id: 0,
            product_id: 0,
            product_name: "Not connected".into(),
            serial: String::new(),
            connected: false,
        },
    }
}

#[tauri::command]
pub fn device_state() -> DeviceState {
    load_device_state()
}

/// Program the pad with key bindings only. Lighting is handled separately via
/// `device_set_lighting`.
#[tauri::command]
pub fn device_program(bindings_json: String) -> Result<ProgramResult, String> {
    let bindings: Vec<KeyBinding> =
        serde_json::from_str(&bindings_json).map_err(|e| format!("bad bindings: {e}"))?;

    let messages = bindings
        .iter()
        .map(build_key_messages)
        .collect::<Result<Vec<_>, _>>()?;

    let _lock = DEVICE_LOCK.lock().map_err(|e| format!("lock: {e}"))?;
    let device = open_device()?;

    // Wake-up message (all zeros). Some hidapi backends reject report ID 0, which is harmless.
    let _ = device.write(&[0u8; REPORT_SIZE + 1]);
    std::thread::sleep(std::time::Duration::from_millis(10));

    let mut keys_written = 0usize;
    let mut knobs_written = 0usize;

    for (binding, msgs) in bindings.iter().zip(&messages) {
        for msg in msgs {
            send_report(&device, msg)?;
        }
        if binding.is_knob {
            knobs_written += 1;
        } else {
            keys_written += 1;
        }
    }

    // Persist state (keep existing lighting)
    let mut state = load_device_state();
    state.bindings = bindings;
    state.programmed_at = Some(chrono_now());
    save_device_state(&state)?;

    Ok(ProgramResult {
        keys_written,
        knobs_written,
        leds_written: 0,
        saved: true,
    })
}

/// Write a distinct chord (`modifiers` + a, b, c, …) to every firmware key id from
/// `first_id` to `last_id` on one layer, so the knob finder can see which id each
/// physical input fires. Doesn't update the saved device state; "Program pad" restores
/// the real bindings afterwards.
#[tauri::command]
pub fn device_probe_slots(
    layer: u8,
    first_id: u8,
    last_id: u8,
    modifiers: u8,
) -> Result<usize, String> {
    if first_id == 0
        || last_id < first_id
        || last_id > protocol::MAX_KEY_ID
        || last_id - first_id >= 26
    {
        return Err(format!("invalid probe range {first_id}–{last_id}"));
    }
    let messages = (first_id..=last_id)
        .enumerate()
        .map(|(i, id)| {
            build_key_messages(&KeyBinding {
                layer,
                input: 0,
                is_knob: false,
                modifiers,
                keycode: 4 + i as u8,
                is_media: false,
                media_code: 0,
                key_id: Some(id),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let _lock = DEVICE_LOCK.lock().map_err(|e| format!("lock: {e}"))?;
    let device = open_device()?;
    let _ = device.write(&[0u8; REPORT_SIZE + 1]);
    std::thread::sleep(std::time::Duration::from_millis(10));
    for msgs in &messages {
        for msg in msgs {
            send_report(&device, msg)?;
        }
    }
    Ok(messages.len())
}

/// Apply lighting to the pad without touching key bindings.
/// `layers_json`: JSON array of LayerLighting objects (up to 3).
#[tauri::command]
pub fn device_set_lighting(layers_json: String) -> Result<usize, String> {
    let layers: Vec<LayerLighting> =
        serde_json::from_str(&layers_json).map_err(|e| format!("bad lighting: {e}"))?;

    let messages = layers
        .iter()
        .map(build_led_message)
        .collect::<Result<Vec<_>, _>>()?;

    let _lock = DEVICE_LOCK.lock().map_err(|e| format!("lock: {e}"))?;
    let device = open_device()?;

    for msg in &messages {
        send_report(&device, msg)?;
    }

    // Persist lighting in device state
    let mut state = load_device_state();
    state.lighting = layers;
    state.programmed_at = Some(chrono_now());
    save_device_state(&state)?;

    Ok(messages.len())
}

/// Play a sequence of LED frames on the pad, then optionally restore saved lighting.
/// Each frame is a list of LayerLighting objects. Runs on a background thread and emits
/// `lighting-sequence-finished` when done.
#[tauri::command]
pub fn device_play_frames(
    app: tauri::AppHandle,
    frames_json: String,
    frame_ms: u64,
    restore_json: String,
) -> Result<(), String> {
    let frames: Vec<Vec<LayerLighting>> =
        serde_json::from_str(&frames_json).map_err(|e| format!("bad frames: {e}"))?;
    let restore: Vec<LayerLighting> =
        serde_json::from_str(&restore_json).map_err(|e| format!("bad restore: {e}"))?;

    // Build all messages upfront so errors surface immediately.
    let frame_messages: Vec<Vec<[u8; REPORT_SIZE]>> = frames
        .iter()
        .map(|frame| {
            frame
                .iter()
                .map(build_led_message)
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let restore_messages: Vec<[u8; REPORT_SIZE]> = restore
        .iter()
        .map(build_led_message)
        .collect::<Result<Vec<_>, _>>()?;

    std::thread::spawn(move || {
        use tauri::Emitter;

        let result = (|| -> Result<(), String> {
            let _lock = DEVICE_LOCK.lock().map_err(|e| format!("lock: {e}"))?;
            let device = open_device()?;

            for msgs in &frame_messages {
                for msg in msgs {
                    send_report(&device, msg)?;
                }
                std::thread::sleep(std::time::Duration::from_millis(frame_ms));
            }

            // Restore saved lighting
            for msg in &restore_messages {
                send_report(&device, msg)?;
            }

            Ok(())
        })();

        let payload = match result {
            Ok(()) => serde_json::json!({ "ok": true }),
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        };
        let _ = app.emit("lighting-sequence-finished", payload);
    });

    Ok(())
}

/// Start a background thread that polls for device connect/disconnect every 2 seconds
/// and emits `device-connected` / `device-disconnected` events.
pub fn start_hotplug_poll(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use tauri::Emitter;
        let mut was_connected = false;
        loop {
            let connected = find_device().is_ok();
            if connected && !was_connected {
                let _ = app.emit("device-connected", ());
            } else if !connected && was_connected {
                let _ = app.emit("device-disconnected", ());
            }
            was_connected = connected;
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

fn chrono_now() -> String {
    // Simple ISO-ish timestamp without pulling in the chrono crate.
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    format!("{secs}")
}
