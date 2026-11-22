# Clock firmware (ESP8684 / ESP32-C2)

Firmware for the "Smart Weather Clock" turned Cursor status display. Device notes: `../docs/cursor-display-device.md`.

Everything goes over WiFi. There's no serial cable and no hardware changes.

## Layout
- `secrets.env`: your WiFi details. Git-ignored and only used locally. Template: `secrets.env.example`.
- `tools/patch-wifi.py`: puts the secrets into a built image on your Mac and fixes its checksum and hash.
- `rescue/`: the rescue/probe firmware (ESP-IDF v5.5.1, target esp32c2, 26 MHz crystal). `rescue/bin/clock_rescue.bin` is the prebuilt image.
- `display/`: the Cursor status display firmware. It has the same maintenance endpoints as the rescue firmware, plus `/state` and `/lcd`. `display/bin/cursor_display.bin` is the prebuilt image.
- `tools/gen-fonts.py`: regenerates `display/main/fonts.h` from Inter.

## Step 1: flash the rescue firmware (one time, from the stock firmware)

```bash
cd ~/Documents/WebProjects/macro-controller
# 1. fill in firmware/secrets.env (2.4 GHz network)
python3 firmware/tools/patch-wifi.py firmware/rescue/bin/clock_rescue.bin
esptool --chip esp32c2 image-info firmware/rescue/bin/clock_rescue.patched.bin   # optional: shows "valid" checksum and hash
# 2. upload through the stock OTA endpoint (it expects a filename starting with SDC2)
curl -F "update=@firmware/rescue/bin/clock_rescue.patched.bin;filename=SDC2_rescue.bin" http://192.168.0.89/update_ota
```

The clock reboots. The screen will probably go dark or freeze, because the rescue firmware has no display code. Give it about 20 seconds, then:

```bash
curl http://192.168.0.89/info        # the IP usually stays the same (same MAC). Otherwise check your router's device list.
```

If it doesn't join your WiFi, it always runs its own hotspot. Join **clock-rescue** (password `clockrescue`) and use `http://192.168.4.1`.

## Step 2: back up the whole chip (do this before anything else)

```bash
curl -o firmware/backup/flash-full.bin http://192.168.0.89/flash     # 4 MB, takes about 1 minute
```

## Step 3: flash the display firmware (from the rescue firmware)

This overwrites the original clock firmware in slot `app0`. It's safe because the full backup exists, and `backup/stock-app0.bin` can be uploaded through `/ota` to restore it.

```bash
python3 firmware/tools/patch-wifi.py firmware/display/bin/cursor_display.bin
curl --data-binary @firmware/display/bin/cursor_display.patched.bin "http://192.168.0.89/ota?confirm=1"
```

On boot it shows red, green, blue and white bars, then the status screen. Test it with:

```bash
curl -d '{"state":"thinking","model":"claude-opus-4.5","effort":"High","mode":"Agent","ctx_used":84000,"ctx_max":200000,"tokens":1250000,"agents":2}' http://192.168.0.89/state
```

Panel tuning, if the colours or position look off: `curl "http://192.168.0.89/lcd?bars=1"`, `?madctl=0x08` (swap red and blue), `?inv=0`, `?xoff=0&yoff=0`, `?bl=50`.

**Safe mode:** if the display firmware ever crashes, the next boot skips the display and only runs WiFi and the update endpoint, so you can always flash a fix. Power-cycle the device to try the display again.

## Rescue firmware endpoints
| | |
|---|---|
| `GET /info` | chip, flash, partition table, app in each slot, WiFi, heap |
| `GET /flash[?offset=&len=]` | raw flash read (default: whole chip) |
| `POST /ota?confirm=1` (`--data-binary @app.bin`) | write the **other** slot (where the stock firmware lives) and reboot into it |
| `POST /boot-stock` | boot the original firmware again (as long as `/ota` hasn't overwritten it) |
| `POST /reboot` | reboot |

## Building (only needed if you change the code)
ESP-IDF v5.5.1: `cd firmware/rescue && idf.py set-target esp32c2 && idf.py build`. The output is `build/clock_rescue.bin`.
