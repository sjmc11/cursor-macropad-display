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
exports.SEND_MODES = void 0;
exports.expandHome = expandHome;
exports.loadConfig = loadConfig;
exports.loadPrompts = loadPrompts;
exports.fingerprint = fingerprint;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const jsonc_1 = require("../../shared/jsonc");
var types_1 = require("../../shared/types");
Object.defineProperty(exports, "SEND_MODES", { enumerable: true, get: function () { return types_1.SEND_MODES; } });
function expandHome(p) {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
function loadConfig(configPath) {
    const file = expandHome(configPath);
    const raw = (0, jsonc_1.parseJsonc)(fs.readFileSync(file, 'utf8'));
    const cfg = {
        bridge: { port: 47615, tokenFile: '~/.macropad/token', ...raw.bridge },
        defaults: { sendMode: 'paste+send', afterKeysDelayMs: 60, beforeSendDelayMs: 120, ...raw.defaults },
        chat: { focus: [], newChat: [], send: [], ...raw.chat },
        promptsDir: path.resolve(path.dirname(file), expandHome(raw.promptsDir ?? '../prompts')),
        cycles: raw.cycles ?? {},
        inputs: raw.inputs ?? {},
    };
    return cfg;
}
function loadPrompts(dir) {
    const prompts = new Map();
    if (!fs.existsSync(dir))
        return prompts;
    for (const name of fs.readdirSync(dir).sort()) {
        if (!name.endsWith('.md'))
            continue;
        const id = name.replace(/\.md$/, '');
        const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
        const lines = text.split('\n');
        let title = id;
        if (lines[0]?.startsWith('# ')) {
            title = lines[0].slice(2).trim();
            lines.shift();
        }
        prompts.set(id, { id, title, body: lines.join('\n').trim() });
    }
    return prompts;
}
/** Fingerprint of config + prompt files, so we can hot-reload cheaply on each input. */
function fingerprint(configPath, promptsDir) {
    const parts = [];
    const stat = (p) => { try {
        return fs.statSync(p).mtimeMs;
    }
    catch {
        return 0;
    } };
    parts.push(String(stat(expandHome(configPath))));
    if (fs.existsSync(promptsDir)) {
        for (const n of fs.readdirSync(promptsDir).sort())
            parts.push(n + stat(path.join(promptsDir, n)));
    }
    return parts.join('|');
}
//# sourceMappingURL=config.js.map