"use strict";
// Config validation — returns structured errors so the UI can show them inline.
// Pure functions — no file I/O, works in both Node and browser.
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = validate;
const types_1 = require("./types");
const scheme_1 = require("./scheme");
const chatKeys = new Set(['focus', 'newChat', 'send']);
const browserOps = new Set(['focusOrNew', 'new']);
const keyRe = /^((cmd|ctrl|alt|shift|opt|option|fn)\+)*([a-z0-9]|[.,/;'\[\]\\`=-]|enter|return|backspace|delete|esc|escape|space|tab|up|down|left|right|f\d{1,2})$/;
const validModes = ['paste', 'paste+send', 'newChat+send'];
const validSources = ['prompts', 'sendModes', 'gitBranches', 'cursorModels', 'list'];
function checkSteps(where, steps, promptIds, results) {
    if (!Array.isArray(steps)) {
        results.push({ path: where, message: 'steps must be an array', level: 'error' });
        return;
    }
    steps.forEach((s, i) => {
        const w = `${where}[${i}]`;
        if ('prompt' in s && !promptIds.has(s.prompt))
            results.push({ path: w, message: `unknown prompt "${s.prompt}"`, level: 'error' });
        if ('keys' in s && !keyRe.test(s.keys))
            results.push({ path: w, message: `odd key combo "${s.keys}"`, level: 'error' });
        if ('chat' in s && !chatKeys.has(s.chat))
            results.push({ path: w, message: 'chat must be focus|newChat|send', level: 'error' });
        if ('mode' in s && !validModes.includes(s.mode))
            results.push({ path: w, message: `bad mode "${s.mode}"`, level: 'error' });
        if ('browser' in s && !browserOps.has(s.browser))
            results.push({ path: w, message: 'browser must be focusOrNew|new', level: 'error' });
        const kinds = ['command', 'keys', 'terminal', 'shell', 'prompt', 'chat', 'browser', 'delay', 'notify'].filter((k) => k in s);
        if (kinds.length !== 1)
            results.push({ path: w, message: `expected exactly one step type, got [${kinds}]`, level: 'error' });
    });
}
function validate(cfg, device, promptIds) {
    const results = [];
    const validIds = new Set((0, scheme_1.allInputs)(device).map((i) => i.inputId));
    for (const [k, steps] of Object.entries(cfg.chat ?? {}))
        checkSteps(`chat.${k}`, steps, promptIds, results);
    for (const [name, c] of Object.entries(cfg.cycles ?? {})) {
        if (!validSources.includes(c.source))
            results.push({ path: `cycles.${name}`, message: 'bad source', level: 'error' });
        if (c.source === 'list')
            (c.items ?? []).forEach((it, i) => checkSteps(`cycles.${name}.items[${i}]`, it.steps, promptIds, results));
    }
    for (const [id, a] of Object.entries(cfg.inputs ?? {})) {
        if (!validIds.has(id))
            results.push({ path: `inputs.${id}`, message: 'not a valid input id', level: 'error' });
        if (device.appOnly[id])
            results.push({ path: `inputs.${id}`, message: 'handled by the pad, Cursor will never see it', level: 'warn' });
        if ('steps' in a) {
            checkSteps(`inputs.${id}`, a.steps, promptIds, results);
        }
        else {
            if (!cfg.cycles?.[a.cycle])
                results.push({ path: `inputs.${id}`, message: `unknown cycle "${a.cycle}"`, level: 'error' });
            else if (!['next', 'prev', 'select'].includes(a.do))
                results.push({ path: `inputs.${id}`, message: 'do must be next|prev|select', level: 'error' });
        }
    }
    const unassigned = [...validIds].filter((id) => !cfg.inputs?.[id] && !device.appOnly[id]);
    if (unassigned.length)
        results.push({ path: 'inputs', message: `unassigned inputs: ${unassigned.join(', ')}`, level: 'warn' });
    // Lighting validation
    const lighting = device.lighting;
    if (lighting) {
        const hexRe = /^#[0-9a-fA-F]{6}$/;
        const validKeyNums = new Set(device.physicalRows.flat());
        if (lighting.layers) {
            for (const [layerKey, lcfg] of Object.entries(lighting.layers)) {
                const p = `lighting.layers.${layerKey}`;
                if (!types_1.LED_MODE_NAMES.includes(lcfg.mode))
                    results.push({ path: p, message: `unknown LED mode "${lcfg.mode}"`, level: 'error' });
                if (lcfg.color && !hexRe.test(lcfg.color))
                    results.push({ path: `${p}.color`, message: `bad hex colour "${lcfg.color}"`, level: 'error' });
                if (lcfg.keys) {
                    for (const [kid, hex] of Object.entries(lcfg.keys)) {
                        const n = parseInt(kid.replace('K', ''), 10);
                        if (isNaN(n) || !validKeyNums.has(n))
                            results.push({ path: `${p}.keys.${kid}`, message: `unknown key "${kid}"`, level: 'error' });
                        if (!hexRe.test(hex))
                            results.push({ path: `${p}.keys.${kid}`, message: `bad hex colour "${hex}"`, level: 'error' });
                    }
                }
            }
        }
        if (lighting.startup) {
            const s = lighting.startup;
            if (!types_1.STARTUP_PRESETS.includes(s.preset))
                results.push({ path: 'lighting.startup.preset', message: `unknown preset "${s.preset}"`, level: 'error' });
            if (s.fps < 1 || s.fps > 30)
                results.push({ path: 'lighting.startup.fps', message: `fps must be 1–30, got ${s.fps}`, level: 'error' });
            if (s.durationMs < 100 || s.durationMs > 15000)
                results.push({ path: 'lighting.startup.durationMs', message: `durationMs must be 100–15000`, level: 'error' });
        }
    }
    return results;
}
//# sourceMappingURL=validate.js.map