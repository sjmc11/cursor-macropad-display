# Device protocol notes

## Confirmed device details

| Property         | Value                    |
| ---------------- | ------------------------ |
| Model name       | 12KV3 (12 keys, 3 knobs) |
| USB product name | `USB Composite Device`   |
| USB VendorID     | `0x514C` (20812)         |
| USB ProductID    | `0x8850` (34896)         |
| Serial           | `CD70134331323531`       |
| Bluetooth name   | `MINI_KEYBOARD`          |
| BT VendorID      | `0x05AC` (spoofed Apple) |
| BT ProductID     | `0x022C`                 |
| BT address       | `1A:07:21:BA:6B:61`      |

## USB HID interfaces

The pad is a USB composite device with two HID interfaces:

### 1. Vendor interface (programming)

- **UsagePage**: `0xFF00` (vendor-defined)
- **Usage**: `1`
- **MaxInputReportSize**: 65 bytes (1 report ID + 64 data)
- **MaxOutputReportSize**: 65 bytes
- **Report ID**: `3`

This is the endpoint the Mini_Keyboard app uses to program key bindings,
knob actions, and LED settings. The 64-byte payload matches the CH57x
protocol family, though with different VID/PID (`0x514C`/`0x8850` instead
of the typical `0x1189`/`0x8890`).

### 2. Keyboard interface (input)

- **UsagePage**: `1` (Generic Desktop)
- **Usage**: `6` (Keyboard)
- **MaxInputReportSize**: 12 bytes
- **MaxOutputReportSize**: 2 bytes

Standard USB HID keyboard — this is where keystrokes and modifier combos
are sent to the Mac.

## Why `system_profiler SPUSBDataType` shows nothing

On Apple Silicon Macs, some USB devices connected through internal hubs or
via certain chipsets don't appear in `SPUSBDataType`. The device IS visible
in `ioreg -c IOHIDDevice` and works as a USB HID device. The
Mini_Keyboard app and macOS HID subsystem both see it correctly.

## Programming protocol

Taken from [ch57x-keyboard-tool](https://github.com/kriomant/ch57x-keyboard-tool)'s
`k8850_4x4` driver (model `ch57x-3`), which lists this exact VID/PID. Implemented in
`app/src-tauri/src/device/protocol.rs`.

Every message is 64 bytes starting with report ID `0x03`, zero-padded. Send one
all-zero message first. Each binding is two messages:

```
03 FD <key id> <layer 1-based> <kind> 00 <count> [00 00 <code>] × count   (binding)
03 FD FE FF                                                               (finish)
```

- **Key id**: buttons `1`–`16` (Mini_Keyboard key numbers); knobs `17 + 3 × knob + action`,
  action `0` = turn left, `1` = press, `2` = turn right.
- **Kind 1 (keyboard)**: each modifier is its own entry — `F1` ctrl, `F2` shift, `F3` alt,
  `F4` cmd/win (`F5`–`F8` right-hand versions) — followed by the HID keycode. Max 18 entries.
- **Kind 2 (media)**: `00 02 00 00 <usage low> 00 00 <usage high>`.
- Bindings persist on their own; there is no save/commit message.

Which knob is index 0 isn't confirmed, and the `17 +` base comes from a 16-key pad — on the
12-key pad the knobs may start at 13. Without measurements the app assumes small = 0,
mid = 1, big = 2 from 17. The **Knob finder** (Device tab) writes a distinct chord to ids
13–28, records which id each knob action fires, and saves the result as `knobSlots` in
`config/device.jsonc`; "Program pad" then writes knob bindings to those exact ids.

## LED control protocol

Derived from [ch57x-keyboard-tool PR #175](https://github.com/kriomant/ch57x-keyboard-tool/pull/175),
which was hardware-tested on a 16-key 0x8850 pad. Implemented in
`app/src-tauri/src/device/protocol.rs` (`build_led_message`).

One 64-byte message per layer, no finish message required:

```
03 FE B0 <layer 0-based> <mode> <base R> <base G> <base B> [<R> <G> <B>] × 16
```

- **Byte 0** (`0x03`): report ID.
- **Bytes 1–2** (`0xFE 0xB0`): LED command header.
- **Byte 3**: layer index (0, 1, or 2).
- **Byte 4**: mode — `0` off, `1` static, `2` reactive (lights on press), `3` ripple,
  `4` rainbow rows, `5` rainbow columns.
- **Bytes 5–7**: base colour (R, G, B). Ignored for rainbow modes.
- **Bytes 8–55**: 16 per-key colours (3 bytes each, R G B). The firmware reserves
  16 slots regardless of how many physical keys exist. For a 12-key pad, slots 12–15
  are unused. Slot `n-1` corresponds to Mini_Keyboard key number `n` (default; can be
  overridden via `ledSlots` in `device.jsonc`).

The firmware applies each message immediately — changes are visible as soon as the
message is sent. No separate save/commit is needed.

### Known firmware issues

- **Animation freeze**: animated modes (reactive, ripple, rainbow) can freeze after
  a variable amount of time (observed: 2 s – 2 min). This is a pre-existing firmware
  bug that also happens with no USB writes. Static and off modes are unaffected.
  Replugging the pad recovers.
- **Persistence**: LED settings may or may not persist across replug depending on
  firmware version. Macropad Studio re-applies lighting on connect via its startup
  sequence feature.

### Lighting config in `device.jsonc`

```jsonc
"lighting": {
  "layers": {
    "1": { "mode": "static", "color": "#3b82f6", "keys": { "K9": "#ff0080" } },
    "2": { "mode": "reactive", "color": "#22c55e" },
    "3": { "mode": "rainbowRows" }
  },
  "startup": { "enabled": true, "preset": "sweep", "durationMs": 2500, "fps": 12 }
}
```

- **modes**: `off`, `static`, `reactive`, `ripple`, `rainbowRows`, `rainbowCols`.
- **color**: hex `#RRGGBB` base colour for the layer.
- **keys**: optional per-key colour overrides (`K1`–`K12`). Keys without overrides
  use the layer colour.
- **startup**: host-driven animation played when the pad connects. Presets:
  `sweep`, `rainbowChase`, `sparkle`, `pulse`. The Mac sends a sequence of static
  frames at the configured `fps` for `durationMs`, then restores the saved lighting.
- **ledSlots**: optional override mapping physical key numbers to firmware LED
  slot indices, in case the default (`slot = keyNum - 1`) doesn't match.

## Verified

- [x] USB connection confirmed (VID `0x514C`, PID `0x8850`)
- [x] Vendor HID interface found (64-byte reports, UsagePage `0xFF00`)
- [x] Keyboard HID interface found (keystrokes work)
- [x] Pad works over both USB and Bluetooth
- [x] Programmed layout persists in flash
- [ ] Key programming from Macropad Studio (format above, not yet tested on this unit)
- [ ] Knob index order
- [ ] LED control — protocol implemented, awaiting hardware test on this unit
