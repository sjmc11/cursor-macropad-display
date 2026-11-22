"use strict";
// Lighting helpers — builds the wire-format LayerLighting objects from config,
// and generates startup animation frames.
// Pure functions — no file I/O, works in both Node and browser.
Object.defineProperty(exports, "__esModule", { value: true });
exports.hexToRgb = hexToRgb;
exports.rgbToHex = rgbToHex;
exports.keySlot = keySlot;
exports.buildLayerLighting = buildLayerLighting;
exports.buildAllLighting = buildAllLighting;
exports.generateStartupFrames = generateStartupFrames;
const types_1 = require("./types");
const LED_KEY_SLOTS = 16;
// ---- Colour helpers ----
function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.substring(0, 2), 16) || 0,
        parseInt(h.substring(2, 4), 16) || 0,
        parseInt(h.substring(4, 6), 16) || 0,
    ];
}
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}
function lerpRgb(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}
function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) {
        r = c;
        g = x;
    }
    else if (h < 120) {
        r = x;
        g = c;
    }
    else if (h < 180) {
        g = c;
        b = x;
    }
    else if (h < 240) {
        g = x;
        b = c;
    }
    else if (h < 300) {
        r = x;
        b = c;
    }
    else {
        r = c;
        b = x;
    }
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}
// ---- Slot mapping ----
/** Map physical key number (1-12) to firmware LED slot index (0-15). */
function keySlot(keyNum, ledSlots) {
    if (ledSlots && keyNum in ledSlots)
        return ledSlots[keyNum];
    return keyNum - 1; // default: slot n-1
}
// ---- Build wire-format LayerLighting from config ----
function buildLayerLighting(layerIndex, cfg, device) {
    const mode = cfg ? types_1.LED_MODE_BYTE[cfg.mode] : 0;
    const base = cfg?.color ? hexToRgb(cfg.color) : [0, 0, 0];
    const keys = Array.from({ length: LED_KEY_SLOTS }, () => [...base]);
    if (cfg?.keys) {
        const slots = device.lighting?.ledSlots;
        for (const [kid, hex] of Object.entries(cfg.keys)) {
            const keyNum = parseInt(kid.replace('K', ''), 10);
            if (isNaN(keyNum))
                continue;
            const slot = keySlot(keyNum, slots);
            if (slot >= 0 && slot < LED_KEY_SLOTS) {
                keys[slot] = hexToRgb(hex);
            }
        }
    }
    return { layer: layerIndex, mode, base, keys };
}
/** Build LayerLighting objects for all 3 layers from device config. */
function buildAllLighting(device) {
    const lighting = device.lighting;
    return [0, 1, 2].map((i) => {
        const layerCfg = lighting?.layers?.[String(i + 1)];
        return buildLayerLighting(i, layerCfg, device);
    });
}
function makeFrame(layer, mode, base, keys) {
    const padded = Array.from({ length: LED_KEY_SLOTS }, (_, i) => keys[i] ? [...keys[i]] : [0, 0, 0]);
    return { layer, mode, base, keys: padded };
}
/** Get the column index for each physical key, derived from physicalRows. */
function keyColumns(device) {
    const map = new Map();
    for (const row of device.physicalRows) {
        for (let col = 0; col < row.length; col++) {
            map.set(row[col], col);
        }
    }
    return map;
}
function keyRow(device) {
    const map = new Map();
    for (let r = 0; r < device.physicalRows.length; r++) {
        for (const k of device.physicalRows[r]) {
            map.set(k, r);
        }
    }
    return map;
}
/** All physical key numbers from the device config. */
function allKeyNums(device) {
    return device.physicalRows.flat();
}
function generateStartupFrames(device, preset, durationMs, fps) {
    const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
    const keyNums = allKeyNums(device);
    const slots = device.lighting?.ledSlots;
    const cols = keyColumns(device);
    const rows = keyRow(device);
    const numCols = device.physicalRows[0]?.length ?? 3;
    const numRows = device.physicalRows.length;
    const frames = [];
    for (let f = 0; f < totalFrames; f++) {
        const t = f / Math.max(1, totalFrames - 1); // 0..1
        const keys = Array(LED_KEY_SLOTS).fill(null).map(() => [0, 0, 0]);
        switch (preset) {
            case 'sweep': {
                const sweepPos = t * (numCols + 1);
                for (const kn of keyNums) {
                    const col = cols.get(kn) ?? 0;
                    const dist = Math.abs(col - sweepPos);
                    const brightness = Math.max(0, 1 - dist * 0.8);
                    const slot = keySlot(kn, slots);
                    if (slot < LED_KEY_SLOTS) {
                        keys[slot] = hslToRgb(210, 0.9, brightness * 0.5);
                    }
                }
                break;
            }
            case 'rainbowChase': {
                for (const kn of keyNums) {
                    const col = cols.get(kn) ?? 0;
                    const row = rows.get(kn) ?? 0;
                    const hue = ((col / numCols + row / numRows) * 180 + t * 360) % 360;
                    const slot = keySlot(kn, slots);
                    if (slot < LED_KEY_SLOTS) {
                        keys[slot] = hslToRgb(hue, 1, 0.45);
                    }
                }
                break;
            }
            case 'sparkle': {
                for (const kn of keyNums) {
                    const slot = keySlot(kn, slots);
                    if (slot < LED_KEY_SLOTS) {
                        const on = Math.sin(t * Math.PI * 6 + kn * 1.7) > 0.3;
                        keys[slot] = on ? [255, 255, 255] : [0, 0, 0];
                    }
                }
                break;
            }
            case 'pulse': {
                const brightness = (Math.sin(t * Math.PI * 2) + 1) / 2;
                const rgb = lerpRgb([0, 0, 0], [59, 130, 246], brightness);
                for (const kn of keyNums) {
                    const slot = keySlot(kn, slots);
                    if (slot < LED_KEY_SLOTS) {
                        keys[slot] = rgb;
                    }
                }
                break;
            }
        }
        frames.push([makeFrame(0, 1, [0, 0, 0], keys)]);
    }
    return frames;
}
//# sourceMappingURL=lighting.js.map