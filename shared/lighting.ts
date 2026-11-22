// Lighting helpers — builds the wire-format LayerLighting objects from config,
// and generates startup animation frames.
// Pure functions — no file I/O, works in both Node and browser.

import type {
  DeviceConfig,
  LayerLighting,
  LayerLightingConfig,
  LightingConfig,
  StartupPreset,
} from './types';
import { LED_MODE_BYTE } from './types';

const LED_KEY_SLOTS = 16;

// ---- Colour helpers ----

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0,
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function lerpRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// ---- Slot mapping ----

/** Map physical key number (1-12) to firmware LED slot index (0-15). */
export function keySlot(keyNum: number, ledSlots?: Record<number, number>): number {
  if (ledSlots && keyNum in ledSlots) return ledSlots[keyNum];
  return keyNum - 1; // default: slot n-1
}

// ---- Build wire-format LayerLighting from config ----

export function buildLayerLighting(
  layerIndex: number,
  cfg: LayerLightingConfig | undefined,
  device: DeviceConfig,
): LayerLighting {
  const mode = cfg ? LED_MODE_BYTE[cfg.mode] : 0;
  const base: [number, number, number] = cfg?.color ? hexToRgb(cfg.color) : [0, 0, 0];

  const keys: [number, number, number][] = Array.from({ length: LED_KEY_SLOTS }, () =>
    [...base] as [number, number, number],
  );

  if (cfg?.keys) {
    const slots = device.lighting?.ledSlots;
    for (const [kid, hex] of Object.entries(cfg.keys)) {
      const keyNum = parseInt(kid.replace('K', ''), 10);
      if (isNaN(keyNum)) continue;
      const slot = keySlot(keyNum, slots);
      if (slot >= 0 && slot < LED_KEY_SLOTS) {
        keys[slot] = hexToRgb(hex);
      }
    }
  }

  return { layer: layerIndex, mode, base, keys };
}

/** Build LayerLighting objects for all 3 layers from device config. */
export function buildAllLighting(device: DeviceConfig): LayerLighting[] {
  const lighting = device.lighting;
  return [0, 1, 2].map((i) => {
    const layerCfg = lighting?.layers?.[String(i + 1)] as LayerLightingConfig | undefined;
    return buildLayerLighting(i, layerCfg, device);
  });
}

// ---- Startup animation frames ----

type Rgb = [number, number, number];

function makeFrame(layer: number, mode: number, base: Rgb, keys: Rgb[]): LayerLighting {
  const padded: Rgb[] = Array.from({ length: LED_KEY_SLOTS }, (_, i) =>
    keys[i] ? [...keys[i]] as Rgb : [0, 0, 0],
  );
  return { layer, mode, base, keys: padded };
}

/** Get the column index for each physical key, derived from physicalRows. */
function keyColumns(device: DeviceConfig): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of device.physicalRows) {
    for (let col = 0; col < row.length; col++) {
      map.set(row[col], col);
    }
  }
  return map;
}

function keyRow(device: DeviceConfig): Map<number, number> {
  const map = new Map<number, number>();
  for (let r = 0; r < device.physicalRows.length; r++) {
    for (const k of device.physicalRows[r]) {
      map.set(k, r);
    }
  }
  return map;
}

/** All physical key numbers from the device config. */
function allKeyNums(device: DeviceConfig): number[] {
  return device.physicalRows.flat();
}

export function generateStartupFrames(
  device: DeviceConfig,
  preset: StartupPreset,
  durationMs: number,
  fps: number,
): LayerLighting[][] {
  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const keyNums = allKeyNums(device);
  const slots = device.lighting?.ledSlots;
  const cols = keyColumns(device);
  const rows = keyRow(device);
  const numCols = device.physicalRows[0]?.length ?? 3;
  const numRows = device.physicalRows.length;

  const frames: LayerLighting[][] = [];

  for (let f = 0; f < totalFrames; f++) {
    const t = f / Math.max(1, totalFrames - 1); // 0..1
    const keys: Rgb[] = Array(LED_KEY_SLOTS).fill(null).map(() => [0, 0, 0] as Rgb);

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
