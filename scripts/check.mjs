// Validates config/macropad.jsonc against the scheme and prompt files.
// Thin wrapper — the real logic is in shared/.
// Run: node scripts/check.mjs   (after `npm run compile` in extension/)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, loadDeviceConfig, loadConfig } from './scheme.mjs';

const { validate } = await import(path.join(root, 'extension/out/shared/validate.js'));
const { render } = await import(path.join(root, 'extension/out/shared/template.js'));
const { parseJsonc } = await import(path.join(root, 'extension/out/shared/jsonc.js'));

const device = await loadDeviceConfig();
const cfg = await loadConfig();
const promptsDir = path.resolve(root, 'config', cfg.promptsDir ?? '../prompts');
const prompts = new Set(
  fs.readdirSync(promptsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
);

const results = validate(cfg, device, prompts);
const errors = results.filter((r) => r.level === 'error');
const warns = results.filter((r) => r.level === 'warn');

// Unit checks on compiled helpers
assert.equal(render('A {{#s}}[{{s}}]{{/s}}{{^s}}none{{/s}}', { s: 'x' }), 'A [x]');
assert.equal(render('A {{#s}}[{{s}}]{{/s}}{{^s}}none{{/s}}', { s: '' }), 'A none');
assert.equal(render('{{missing}}ok', {}), 'ok');
assert.deepEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }'), { a: 'http://x', b: [1, 2] });

for (const w of warns) console.log('warn:', `${w.path}: ${w.message}`);
if (errors.length) {
  for (const e of errors) console.error('error:', `${e.path}: ${e.message}`);
  process.exit(1);
}
console.log(`Config OK: ${Object.keys(cfg.inputs).length} inputs, ${prompts.size} prompts, unit checks passed`);
