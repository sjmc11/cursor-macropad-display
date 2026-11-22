# Cursor status display (mini WiFi "Smart Weather Clock")

Goal: turn a cheap AliExpress WiFi weather clock (yellow, 240×240 IPS) into a desk display for Cursor: active model, effort, token usage, context %, running agents, working/thinking state.

## Device findings (2026-11-22)

- USB-C supplies power only. No serial port appears on the Mac with a known data cable, so flashing has to happen over WiFi.
- Connected to home WiFi at 192.168.0.89. The stock web UI's title is "Smart Weather Clock".
- MAC prefix b8:7b:4d is Espressif (a block registered in 2026). This doesn't say whether the chip is an ESP8266 or an ESP32 variant.
- Stock UI themes: Classic, Weather, Photo, Dial, Simple, Weather forecast, Flip Clock. GIFs must be 80×80. Filesystem is 2.44 MB.
- OTA: the page asks for a filename starting `SDC2`, but that check is only in the browser JS. The actual update is `POST /update_ota` with a multipart field named `update`, which looks like the Arduino `Update` library.
- Other endpoints: `/config` (JSON, unauthenticated, includes WiFi credentials, so the stock firmware isn't safe), `/api/set?key=`, `/theme/toggle?id=`, `/theme/interval?val=`, `/upload`, `/restart`, `/scanwifi`, `/photo/list`, `/theme/list`.
- Calling `/scanwifi` knocks the stock firmware off WiFi (screen shows IP 0.0.0.0) until it's power-cycled. Avoid it.
- Network probing didn't identify the chip: the HTTP server fingerprint, the hostname (`UNKNOWN` on the router), mDNS, and the Arduino OTA UDP ports (8266 / 3232) were all inconclusive.
- The "Firmware github" link points to JUZIPi-tech/SD*PRO. That repo holds only SDPro*\* bins, with no source and no SDC2 build, so it's probably a sibling product.
- **Chip family: ESP32 (from a TCP fingerprint).** The clock advertises MSS 1436 and a TCP window of 5760, the arduino-esp32 / ESP-IDF lwIP defaults. Arduino ESP8266 would show MSS 536 with window 2144, or MSS 1460 with window 5840. To reproduce, read `TCP_CONNECTION_INFO` on a socket connected to port 80.
- **Chip: ESP8684 (ESP32-C2), from photos of the opened case.** The main chip is a small Espressif QFN marked `ESP868x`, marked `ESP8684 … H4X…`, i.e. ESP8684H4 with 4 MB of in-package flash. Confirmed from a zoomed photo. There's no separate flash chip, and the crystal can is clearly marked **26.000 MHZ** (confirmed). That points to the ESP8684 (ESP32-C2), which supports a 26 MHz crystal. The ESP8685 (ESP32-C3) needs 40 MHz. Build firmware for `esp32c2` with a 26 MHz XTAL.
- Board: AMS1117 3.3 V regulator, PCB trace antenna, FPC connector to the WA54BC049I display. Labelled pads on the underside: `EN`, `IO0`–`IO10`, `IO18`, `TXD0`, `RXD0`, `G`, `V`. A 3.3 V USB-UART adapter on TXD0, RXD0, G and V, with IO9 held low at reset (download mode), can recover the device over serial if an OTA upload goes wrong.

## Findings from the flash backup (2026-11-22)

- Partitions: nvs 0x9000 (0x5000), otadata 0xe000, **app0 0x10000 and app1 0xd0000 (0xC0000 = 768 KB each)**, spiffs 0x190000 (0x270000). Chip revision v2.0. Stock app: ESP-IDF 5.3.2 (Arduino), project name stripped, internal name "SDC2 V1.2.0".
- The stock app is backed up as `firmware/backup/stock-app0.bin`, a valid image that can be uploaded with `/ota` to restore it.
- **Display wiring, from disassembling the stock TFT_eSPI init:** SPI2 with SCLK=GPIO1, MOSI=GPIO2, no MISO, **no CS**, DC=GPIO0, RST=GPIO3. SPI mode 3 at 40 MHz. ST7789 init table with 20 commands, including 0xE4 gate control and 0x21 INVON. Rotation 0, MADCTL 0x00.
- **Backlight: GPIO5, active-low PWM.** Stock duty is `1023 - 10 * brightness`. Pin 5 is held high (off) until init is done.
- GPIO7 is a second PWM output (stock writes duty 511 or 0), probably a buzzer or LED; it's left alone. GPIO18 is INPUT_PULLUP, probably the touch/button input.
- Rescue firmware is in app1. The display firmware goes into app0 (overwriting stock), with the rescue firmware kept as the other slot.

## Decisions (2026-11-22)

- **No soldering or hardware changes: everything goes over WiFi.** The UART pads aren't used.
- Firmware: ESP-IDF targeting `esp32c2`, with `CONFIG_XTAL_FREQ_26=y`. Arduino's support for the C2 is limited, and a wrong crystal setting would kill WiFi, which takes OTA with it.
- The first custom image is a minimal **rescue/probe firmware** with no display code:
  - Joins the home WiFi, and falls back to its own access point if that fails.
  - Keeps a `POST /ota` endpoint.
  - `/info`: chip, partition table, running slot, heap.
  - `/flash`: streams raw flash so the stock firmware can be backed up over WiFi.
  - `/boot-stock`: switches back to the stock firmware, which stays in the other OTA slot.
- Display pins come from analysing the stock app image in that backup (spi_bus / GPIO config).
- Remaining risk: the first boot of the probe image. The stock bootloader probably has no rollback, so a crash before WiFi starts can't be fixed without UART. To keep this low, the image stays minimal and is built from standard ESP-IDF examples (the crystal frequency is confirmed at 26 MHz).

## Plan

1. ~~Identify the chip~~: ESP32-C2 (ESP8684).
2. Build the rescue/probe image. **Built:** `firmware/rescue/bin/clock_rescue.bin`, 538 KB, ESP-IDF v5.5.1. WiFi credentials are patched in locally with `firmware/tools/patch-wifi.py` from the git-ignored `firmware/secrets.env`. It always runs a fallback hotspot `clock-rescue` / `clockrescue` at 192.168.4.1. WPA3 is disabled to keep the image small. Upload steps are in `firmware/README.md`.
3. ~~Back up the flash, read the partition table and find the display pins~~ (done, see findings above).
4. Build the display firmware. **Built:** `firmware/display/bin/cursor_display.bin` (677 KB). Features:
   - `POST /state` JSON for status updates
   - `/lcd` tuning (backlight, offsets)
   - Purple stars startup animation (from `firmware/startup.gif`, 3 frames, 16-color quantized, ~40KB compressed)
   - `POST /reboot` for remote restart
   - Safe mode (no display after a crash)
5. ~~Display firmware flashed~~: it works (colour bars, layout and `/state` all confirmed on 2026-11-22).
6. Mac bridge: **built** in `display-bridge/`. Cursor hooks (observe-only, user-level `~/.cursor/hooks.json`) forward to a launchd Node daemon on 127.0.0.1:47321, which posts to the display. Context is exact only after `preCompact`; otherwise it's estimated from transcript size. Hooks don't expose real token usage.
7. Possible next step: real token usage and context from Cursor's `state.vscdb` (needs read access to `~/Library/Application Support/Cursor`).
