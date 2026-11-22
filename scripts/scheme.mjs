// Thin wrapper — the real logic is in shared/.
// After `npm run compile` in extension/, the compiled shared modules live under extension/out/shared/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { parseJsonc } = await import(path.join(root, 'extension/out/shared/jsonc.js'));
const shared = await import(path.join(root, 'extension/out/shared/scheme.js'));

export const keys = shared.keys;
export const knobs = shared.knobs;
export const knobInputs = shared.knobInputs;

export async function loadDeviceConfig() {
  return parseJsonc(fs.readFileSync(path.join(root, 'config/device.jsonc'), 'utf8'));
}

export async function loadConfig() {
  return parseJsonc(fs.readFileSync(path.join(root, 'config/macropad.jsonc'), 'utf8'));
}

// Convenience re-exports derived from device config.
const device = await loadDeviceConfig();
export const layers = device.layers;
export const physicalRows = device.physicalRows;
export const appOnly = device.appOnly;

export function allInputs() {
  return shared.allInputs(device);
}
