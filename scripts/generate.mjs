// Generates cursor/keybindings.json and docs/mini-keyboard-mapping.md.
// Thin wrapper — the real logic is in shared/.
// Run: node scripts/generate.mjs   (after `npm run compile` in extension/)
import fs from 'node:fs';
import path from 'node:path';
import { root, loadDeviceConfig, loadConfig } from './scheme.mjs';

const { generateKeybindings, generateMappingDoc } = await import(
  path.join(root, 'extension/out/shared/generate.js')
);

const device = await loadDeviceConfig();
const cfg = await loadConfig();

const bindings = generateKeybindings(device);
fs.writeFileSync(path.join(root, 'cursor/keybindings.json'), JSON.stringify(bindings, null, 2) + '\n');

const md = generateMappingDoc(device, cfg);
fs.writeFileSync(path.join(root, 'docs/mini-keyboard-mapping.md'), md);

console.log(`Wrote ${bindings.length} keybindings and docs/mini-keyboard-mapping.md`);
