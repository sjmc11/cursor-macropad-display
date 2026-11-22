"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cursorStateDbPath = cursorStateDbPath;
exports.loadCursorPreferredModels = loadCursorPreferredModels;
exports.cycleCurrentModelEffort = cycleCurrentModelEffort;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const exec = (0, util_1.promisify)(child_process_1.execFile);
const REACTIVE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
/** Path to Cursor's global state DB for the current platform. */
function cursorStateDbPath() {
    const home = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
        return path.join(appData, 'Cursor/User/globalStorage/state.vscdb');
    }
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(config, 'Cursor/User/globalStorage/state.vscdb');
}
function findSqlite3() {
    const candidates = ['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3'];
    for (const c of candidates) {
        if (c === 'sqlite3')
            continue;
        if (fs.existsSync(c))
            return c;
    }
    return 'sqlite3';
}
async function readReactiveStorage() {
    const dbPath = cursorStateDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Cursor state DB not found at ${dbPath}`);
    }
    // Prefer Node's built-in sqlite when available (Node 22+).
    try {
        const { DatabaseSync } = await Promise.resolve(`${'node:sqlite'}`).then(s => __importStar(require(s)));
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(REACTIVE_KEY);
            if (!row?.value)
                throw new Error('reactive storage row missing');
            return JSON.parse(row.value);
        }
        finally {
            db.close();
        }
    }
    catch {
        // Fall back to sqlite3 CLI.
    }
    const sqlite = findSqlite3();
    const { stdout } = await exec(sqlite, [
        '-readonly',
        dbPath,
        `SELECT value FROM ItemTable WHERE key='${REACTIVE_KEY.replace(/'/g, "''")}';`,
    ], { maxBuffer: 20 * 1024 * 1024 });
    const text = stdout.trim();
    if (!text)
        throw new Error('empty reactive storage value');
    return JSON.parse(text);
}
function isEnabled(model, enabled, disabled) {
    const id = model.name;
    if (!id)
        return false;
    if (disabled.has(id))
        return false;
    if (enabled.has(id))
        return true;
    return !!model.defaultOn;
}
function formatLabel(displayName, params) {
    const effort = params.find((p) => ['reasoning_effort', 'effort', 'reasoning'].includes(p.id));
    const fast = params.find((p) => p.id === 'fast' && p.value === 'true');
    const bits = [displayName];
    if (effort?.value) {
        const v = effort.value;
        bits.push(v === 'xhigh' ? 'Extra High' : v.charAt(0).toUpperCase() + v.slice(1));
    }
    if (fast)
        bits.push('Fast');
    return bits.join(' ');
}
/**
 * Models currently shown in Cursor's agent picker (Settings → Models toggles),
 * using each model's last-used parameter preferences when available.
 */
async function loadCursorPreferredModels(opts) {
    const includeAuto = opts?.includeAuto !== false;
    const store = await readReactiveStorage();
    const catalog = store.availableDefaultModels2 ?? [];
    const ai = store.aiSettings ?? {};
    const enabled = new Set(ai.modelOverrideEnabled ?? []);
    const disabled = new Set(ai.modelOverrideDisabled ?? []);
    const prefs = ai.modelParameterPreferences ?? {};
    const out = [];
    const seen = new Set();
    const push = (modelId, displayName) => {
        if (seen.has(modelId))
            return;
        seen.add(modelId);
        const pref = prefs[modelId];
        const parameters = pref?.parameters ?? [];
        const params = parameters.map((p) => ({ id: p.id, value: String(p.value) }));
        out.push({
            modelId,
            label: formatLabel(displayName, params),
            modelIdWithParams: JSON.stringify({ modelId, params }),
        });
    };
    if (includeAuto)
        push('default', 'Auto');
    for (const m of catalog) {
        if (!m.name || m.name === 'default')
            continue;
        // Prefer agent-capable models when the flag is present.
        if (m.supportsAgent === false)
            continue;
        if (!isEnabled(m, enabled, disabled))
            continue;
        push(m.name, m.clientDisplayName || m.name);
    }
    return out;
}
function cycleableValues(def) {
    const enumValues = def.parameterType?.enumParameter?.values;
    const boolValues = def.parameterType?.booleanParameter?.values;
    const raw = enumValues ?? boolValues ?? [];
    const open = raw.filter((v) => !v.blockedByAdminAllowlist);
    return open.length > 0 ? open : raw;
}
function findCycleableParam(model) {
    return (model.parameterDefinitions ?? []).find((d) => d.isCycleableByHotkey === true && !!d.id && cycleableValues(d).length > 1);
}
/**
 * Advance the current composer model's hotkey-cycleable param (effort / thinking).
 * Returns null when the active model has no such parameter (e.g. Auto).
 */
async function cycleCurrentModelEffort(dir, hint) {
    const store = await readReactiveStorage();
    const catalog = store.availableDefaultModels2 ?? [];
    const ai = store.aiSettings ?? {};
    const selected = ai.modelConfig?.composer?.selectedModels?.[0];
    const modelId = selected?.modelId ?? ai.modelConfig?.composer?.modelName;
    if (!modelId || modelId === 'default')
        return null;
    const catalogModel = catalog.find((m) => m.name === modelId);
    if (!catalogModel)
        return null;
    const paramDef = findCycleableParam(catalogModel);
    if (!paramDef?.id)
        return null;
    const values = cycleableValues(paramDef);
    const valueList = values.map((v) => String(v.value ?? ''));
    if (valueList.length < 2)
        return null;
    const prefs = ai.modelParameterPreferences?.[modelId]?.parameters ?? [];
    const currentParams = (selected?.parameters?.length ? selected.parameters : prefs).map((p) => ({
        id: p.id,
        value: String(p.value),
    }));
    // Cursor flushes state.vscdb asynchronously; prefer our recent in-memory value on rapid twists.
    const hinted = hint && hint.modelId === modelId && hint.paramId === paramDef.id ? hint.value : undefined;
    const current = hinted ?? currentParams.find((p) => p.id === paramDef.id)?.value ?? valueList[0];
    let idx = valueList.indexOf(current);
    if (idx < 0)
        idx = 0;
    idx = (idx + (dir === 'next' ? 1 : -1) + valueList.length) % valueList.length;
    const nextValue = valueList[idx];
    const nextMeta = values[idx];
    const nextParams = currentParams.filter((p) => p.id !== paramDef.id);
    nextParams.push({ id: paramDef.id, value: nextValue });
    const displayName = catalogModel.clientDisplayName || modelId;
    const displayValue = nextMeta?.displayName ||
        (nextValue === 'xhigh' ? 'Extra High' : nextValue.charAt(0).toUpperCase() + nextValue.slice(1));
    const label = formatLabel(displayName, nextParams);
    return {
        modelId,
        label,
        modelIdWithParams: JSON.stringify({ modelId, params: nextParams }),
        paramId: paramDef.id,
        paramName: paramDef.name || paramDef.id,
        value: nextValue,
        displayValue,
    };
}
//# sourceMappingURL=cursorModels.js.map