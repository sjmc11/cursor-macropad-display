#!/usr/bin/env python3
"""Patch WiFi credentials into a clock firmware image, locally on your Mac.

The firmware is built with placeholder fields (@@WIFI_SSID@@ / @@WIFI_PASS@@)
so credentials never have to be compiled in, committed or sent anywhere.
This script fills them in from firmware/secrets.env and then recomputes the
image checksum and SHA-256 footer so the device accepts the image.

Usage:
    python3 firmware/tools/patch-wifi.py firmware/rescue/bin/clock_rescue.bin [-o out.bin]

Output defaults to <input>.patched.bin (git-ignored). No dependencies.
"""
import argparse
import hashlib
import pathlib
import struct
import sys

FIRMWARE = pathlib.Path(__file__).resolve().parent.parent  # .../firmware
SECRETS = FIRMWARE / "secrets.env"

FIELDS = {  # marker -> (secrets key, field size incl. NUL, max value length)
    b"@@WIFI_SSID@@": ("WIFI_SSID", 40, 32),
    b"@@WIFI_PASS@@": ("WIFI_PASSWORD", 72, 63),
}


def read_secrets(path):
    if not path.exists():
        sys.exit(f"Missing {path}. Copy secrets.env.example to secrets.env and fill it in.")
    vals = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        vals[k.strip()] = v
    return vals


def fix_footer(img):
    """Recompute checksum + appended SHA-256 for an ESP32-family app image."""
    if img[0] != 0xE9:
        sys.exit("Not an ESP app image (bad magic).")
    seg_count = img[1]
    hash_appended = img[23] == 1
    pos = 24
    checksum = 0xEF
    for _ in range(seg_count):
        _, length = struct.unpack_from("<II", img, pos)
        pos += 8
        for b in img[pos:pos + length]:
            checksum ^= b
        pos += length
    # checksum sits in the last byte of the 16-byte-aligned block
    pad = 15 - (pos % 16)
    pos += pad
    img[pos] = checksum
    pos += 1
    if hash_appended:
        img[pos:pos + 32] = hashlib.sha256(bytes(img[:pos])).digest()
        pos += 32
    if pos != len(img):
        sys.exit(f"Unexpected image layout (parsed {pos} bytes, file has {len(img)}).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("-o", "--out")
    args = ap.parse_args()

    src = pathlib.Path(args.image)
    img = bytearray(src.read_bytes())
    secrets = read_secrets(SECRETS)

    for marker, (key, size, maxlen) in FIELDS.items():
        value = secrets.get(key, "")
        if key == "WIFI_SSID" and not value:
            sys.exit("WIFI_SSID is empty in secrets.env.")
        raw = value.encode("utf-8")
        if len(raw) > maxlen:
            sys.exit(f"{key} is too long ({len(raw)} bytes, max {maxlen}).")
        if img.count(marker) != 1:
            sys.exit(f"Placeholder {marker.decode()} not found exactly once (already patched?).")
        at = img.find(marker)
        img[at:at + size] = raw + b"\0" * (size - len(raw))

    fix_footer(img)
    out = pathlib.Path(args.out) if args.out else src.with_suffix(".patched.bin")
    out.write_bytes(img)
    print(f"Wrote {out} ({len(img)} bytes) with SSID '{secrets['WIFI_SSID']}'.")


if __name__ == "__main__":
    main()
