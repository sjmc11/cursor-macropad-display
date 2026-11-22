//! Programming protocol for the 12KV3 pad (USB 0x514C:0x8850).
//!
//! Ported from ch57x-keyboard-tool's `k8850_4x4` driver (model "ch57x-3"),
//! which targets this exact VID/PID. Each message is 64 bytes and starts with
//! report ID 3. Bindings are written to flash as they arrive; there is no
//! separate save command.

use serde::{Deserialize, Serialize};

// 0x514C/0x8850 = confirmed on this 12KV3 unit. Other CH57x variants use different
// protocols, so only this one is accepted.
pub const VENDOR_IDS: &[u16] = &[0x514C];
pub const PRODUCT_IDS: &[u16] = &[0x8850];

/// Message size, including the leading report ID byte.
pub const REPORT_SIZE: usize = 64;

/// The firmware has slots for 16 buttons; knob slots come after them.
const MAX_BUTTONS: u8 = 16;

/// Highest firmware key id that can be written (16 buttons + 4 knobs × 3 actions).
pub const MAX_KEY_ID: u8 = MAX_BUTTONS + 12;

/// Most modifiers + key presses a single binding can hold.
const MAX_SEQUENCE: usize = 18;

/// A key binding to program onto one input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyBinding {
    pub layer: u8, // 1-based
    /// Keys: 1-12 (Mini_Keyboard app numbering).
    /// Knobs: firmware knob index * 3 + action, where action is 0 = turn left (CCW),
    /// 1 = press, 2 = turn right (CW).
    pub input: u8,
    pub is_knob: bool,
    pub modifiers: u8,  // HID modifier mask (bit 0 = left ctrl … bit 7 = right GUI)
    pub keycode: u8,    // HID keycode (0 = none)
    pub is_media: bool, // true for media keys (volume, etc.)
    pub media_code: u16, // HID consumer usage code
    /// Firmware key id to write to, overriding the id derived from `input`.
    /// Set when the knob slots have been measured with the knob finder.
    #[serde(default)]
    pub key_id: Option<u8>,
}

/// Number of per-key colour slots in an LED message. The firmware reserves 16 regardless of
/// how many physical keys the pad has.
pub const LED_KEY_SLOTS: usize = 16;

/// LED mode byte values recognised by the 8850 firmware.
/// From ch57x-keyboard-tool PR #175, hardware-tested on a 16-key 8850 pad.
pub const LED_MODE_OFF: u8 = 0;
pub const LED_MODE_STATIC: u8 = 1;
pub const LED_MODE_REACTIVE: u8 = 2;
pub const LED_MODE_RIPPLE: u8 = 3;
pub const LED_MODE_RAINBOW_ROWS: u8 = 4;
pub const LED_MODE_RAINBOW_COLS: u8 = 5;

/// All valid LED mode byte values.
pub const LED_MODES: [u8; 6] = [
    LED_MODE_OFF,
    LED_MODE_STATIC,
    LED_MODE_REACTIVE,
    LED_MODE_RIPPLE,
    LED_MODE_RAINBOW_ROWS,
    LED_MODE_RAINBOW_COLS,
];

/// Per-layer lighting state sent to the device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerLighting {
    /// 0-based layer index (0, 1, 2).
    pub layer: u8,
    /// LED mode byte (see LED_MODE_* constants).
    pub mode: u8,
    /// Base colour [R, G, B].
    pub base: [u8; 3],
    /// Per-key colours, 16 slots of [R, G, B]. Keys without individual colours
    /// should be set to the base colour.
    pub keys: [[u8; 3]; LED_KEY_SLOTS],
}

/// Build the 64-byte LED message for one layer.
///
/// Format (from PR #175):
/// ```text
/// [0x03, 0xFE, 0xB0, layer, mode, R, G, B, 16 × (R, G, B)]
/// ```
///
/// No finish message is needed — the firmware applies each layer immediately.
pub fn build_led_message(lighting: &LayerLighting) -> Result<[u8; REPORT_SIZE], String> {
    if lighting.layer >= 3 {
        return Err(format!(
            "invalid LED layer {} (must be 0–2)",
            lighting.layer
        ));
    }
    if !LED_MODES.contains(&lighting.mode) {
        return Err(format!("invalid LED mode {}", lighting.mode));
    }

    let mut msg = [0u8; REPORT_SIZE];
    msg[0] = 0x03;
    msg[1] = 0xFE;
    msg[2] = 0xB0;
    msg[3] = lighting.layer;
    msg[4] = lighting.mode;
    msg[5] = lighting.base[0];
    msg[6] = lighting.base[1];
    msg[7] = lighting.base[2];

    for (i, rgb) in lighting.keys.iter().enumerate() {
        let offset = 8 + i * 3;
        if offset + 2 >= REPORT_SIZE {
            break;
        }
        msg[offset] = rgb[0];
        msg[offset + 1] = rgb[1];
        msg[offset + 2] = rgb[2];
    }

    Ok(msg)
}

/// Build an "off" LED message for a layer (all zeros except the header).
pub fn build_led_off_message(layer: u8) -> Result<[u8; REPORT_SIZE], String> {
    build_led_message(&LayerLighting {
        layer,
        mode: LED_MODE_OFF,
        base: [0, 0, 0],
        keys: [[0, 0, 0]; LED_KEY_SLOTS],
    })
}

fn key_id(binding: &KeyBinding) -> Result<u8, String> {
    if let Some(id) = binding.key_id {
        if id == 0 || id > MAX_KEY_ID {
            return Err(format!("invalid key id {id}"));
        }
        return Ok(id);
    }
    if binding.is_knob {
        if binding.input >= 12 {
            return Err(format!("invalid knob slot {}", binding.input));
        }
        Ok(MAX_BUTTONS + 1 + binding.input)
    } else {
        if binding.input == 0 || binding.input > MAX_BUTTONS {
            return Err(format!("invalid key {}", binding.input));
        }
        Ok(binding.input)
    }
}

fn message(bytes: &[u8]) -> [u8; REPORT_SIZE] {
    let mut msg = [0u8; REPORT_SIZE];
    msg[..bytes.len()].copy_from_slice(bytes);
    msg
}

/// Build the two messages that program one binding: the binding itself, then "finish".
pub fn build_key_messages(binding: &KeyBinding) -> Result<[[u8; REPORT_SIZE]; 2], String> {
    if binding.layer == 0 || binding.layer > 16 {
        return Err(format!("invalid layer {}", binding.layer));
    }
    let mut msg = vec![0x03, 0xfd, key_id(binding)?, binding.layer];

    if binding.is_media {
        let [low, high] = binding.media_code.to_le_bytes();
        msg.extend_from_slice(&[2, 0, 2, 0, 0, low, 0, 0, high]);
    } else {
        // Modifiers are sent as pseudo-keys 0xf1 (ctrl) … 0xf8 (right GUI), then the key.
        let mut sequence: Vec<u8> = (0..8)
            .filter(|bit| binding.modifiers & (1 << bit) != 0)
            .map(|bit| 0xf1 + bit)
            .collect();
        sequence.push(binding.keycode);
        if sequence.len() > MAX_SEQUENCE {
            return Err("key sequence is too long".into());
        }
        msg.extend_from_slice(&[1, 0, sequence.len() as u8]);
        for code in sequence {
            msg.extend_from_slice(&[0, 0, code]);
        }
    }

    Ok([message(&msg), message(&[0x03, 0xfd, 0xfe, 0xff])])
}

/// Map a Cursor/VS Code modifier string to the HID modifier mask.
pub fn parse_modifier_string(mods: &str) -> u8 {
    let mut mask = 0u8;
    for part in mods.split('+') {
        match part.trim().to_lowercase().as_str() {
            "ctrl" | "control" => mask |= 0x01,
            "shift" => mask |= 0x02,
            "alt" | "opt" | "option" => mask |= 0x04,
            "cmd" | "command" | "win" | "gui" | "meta" => mask |= 0x08,
            _ => {} // skip unknown or the key letter itself
        }
    }
    mask
}

/// Map a letter (a-u) to its HID keycode. a=4, b=5, ... z=29.
pub fn letter_to_keycode(letter: char) -> u8 {
    if letter.is_ascii_lowercase() {
        (letter as u8) - b'a' + 4
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(layer: u8, input: u8, is_knob: bool) -> KeyBinding {
        KeyBinding {
            layer,
            input,
            is_knob,
            modifiers: 0x0f,
            keycode: 4,
            is_media: false,
            media_code: 0,
            key_id: None,
        }
    }

    #[test]
    fn explicit_key_id_overrides_input() {
        let mut b = key(1, 0, true);
        b.key_id = Some(13);
        let [msg, _] = build_key_messages(&b).unwrap();
        assert_eq!(&msg[..4], &[0x03, 0xfd, 13, 1]);
        b.key_id = Some(MAX_KEY_ID + 1);
        assert!(build_key_messages(&b).is_err());
    }

    #[test]
    fn key_with_modifiers() {
        let [msg, finish] = build_key_messages(&key(1, 1, false)).unwrap();
        assert_eq!(
            &msg[..22],
            &[0x03, 0xfd, 1, 1, 1, 0, 5, 0, 0, 0xf1, 0, 0, 0xf2, 0, 0, 0xf3, 0, 0, 0xf4, 0, 0, 4]
        );
        assert!(msg[22..].iter().all(|&b| b == 0));
        assert_eq!(&finish[..4], &[0x03, 0xfd, 0xfe, 0xff]);
    }

    #[test]
    fn knob_slots_follow_buttons() {
        let [msg, _] = build_key_messages(&key(3, 0, true)).unwrap();
        assert_eq!(&msg[..4], &[0x03, 0xfd, 17, 3]);
        let [msg, _] = build_key_messages(&key(1, 8, true)).unwrap();
        assert_eq!(msg[2], 25);
    }

    #[test]
    fn media_key() {
        let b = KeyBinding {
            layer: 1,
            input: 0,
            is_knob: true,
            modifiers: 0,
            keycode: 0,
            is_media: true,
            media_code: 0xe9,
            key_id: None,
        };
        let [msg, _] = build_key_messages(&b).unwrap();
        assert_eq!(
            &msg[..13],
            &[0x03, 0xfd, 17, 1, 2, 0, 2, 0, 0, 0xe9, 0, 0, 0]
        );
    }

    // ---- LED tests ----

    #[test]
    fn led_static_red_layer_0() {
        let lighting = LayerLighting {
            layer: 0,
            mode: LED_MODE_STATIC,
            base: [0xFF, 0x00, 0x00],
            keys: [[0xFF, 0x00, 0x00]; LED_KEY_SLOTS],
        };
        let msg = build_led_message(&lighting).unwrap();
        assert_eq!(msg[0], 0x03);
        assert_eq!(msg[1], 0xFE);
        assert_eq!(msg[2], 0xB0);
        assert_eq!(msg[3], 0x00); // layer
        assert_eq!(msg[4], 0x01); // static mode
        assert_eq!(&msg[5..8], &[0xFF, 0x00, 0x00]); // base colour
                                                     // First per-key colour at offset 8
        assert_eq!(&msg[8..11], &[0xFF, 0x00, 0x00]);
        // Last per-key colour that fits (slot 15 at offset 8 + 15*3 = 53)
        assert_eq!(&msg[53..56], &[0xFF, 0x00, 0x00]);
        // Remaining bytes are zero (after 8 + 16*3 = 56)
        assert!(msg[56..].iter().all(|&b| b == 0));
    }

    #[test]
    fn led_off_layer_1() {
        let msg = build_led_off_message(1).unwrap();
        assert_eq!(&msg[..5], &[0x03, 0xFE, 0xB0, 0x01, 0x00]);
        assert!(msg[5..].iter().all(|&b| b == 0));
    }

    #[test]
    fn led_per_key_colours() {
        let mut keys = [[0u8; 3]; LED_KEY_SLOTS];
        keys[0] = [0xFF, 0x00, 0x00]; // red
        keys[5] = [0x00, 0xFF, 0x00]; // green at slot 5
        keys[11] = [0x00, 0x00, 0xFF]; // blue at slot 11
        let lighting = LayerLighting {
            layer: 2,
            mode: LED_MODE_STATIC,
            base: [0x80, 0x80, 0x80],
            keys,
        };
        let msg = build_led_message(&lighting).unwrap();
        assert_eq!(&msg[5..8], &[0x80, 0x80, 0x80]); // base
        assert_eq!(&msg[8..11], &[0xFF, 0x00, 0x00]); // key 0
        assert_eq!(&msg[23..26], &[0x00, 0xFF, 0x00]); // key 5 (offset 8+5*3=23)
        assert_eq!(&msg[41..44], &[0x00, 0x00, 0xFF]); // key 11 (offset 8+11*3=41)
    }

    #[test]
    fn led_invalid_layer() {
        let lighting = LayerLighting {
            layer: 3,
            mode: LED_MODE_STATIC,
            base: [0, 0, 0],
            keys: [[0; 3]; LED_KEY_SLOTS],
        };
        assert!(build_led_message(&lighting).is_err());
    }

    #[test]
    fn led_invalid_mode() {
        let lighting = LayerLighting {
            layer: 0,
            mode: 99,
            base: [0, 0, 0],
            keys: [[0; 3]; LED_KEY_SLOTS],
        };
        assert!(build_led_message(&lighting).is_err());
    }

    #[test]
    fn led_rainbow_rows_no_colour_needed() {
        let lighting = LayerLighting {
            layer: 0,
            mode: LED_MODE_RAINBOW_ROWS,
            base: [0, 0, 0],
            keys: [[0; 3]; LED_KEY_SLOTS],
        };
        let msg = build_led_message(&lighting).unwrap();
        assert_eq!(msg[4], 0x04); // rainbow rows
    }

    #[test]
    fn led_message_exactly_64_bytes() {
        let lighting = LayerLighting {
            layer: 0,
            mode: LED_MODE_STATIC,
            base: [0xFF; 3],
            keys: [[0xFF; 3]; LED_KEY_SLOTS],
        };
        let msg = build_led_message(&lighting).unwrap();
        assert_eq!(msg.len(), 64);
    }
}
