"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJsonc = parseJsonc;
/** Minimal JSONC support: strips // and /* *​/ comments and trailing commas, respecting strings. */
function parseJsonc(text) {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (inString) {
            out += ch;
            if (ch === '\\') {
                out += next ?? '';
                i += 2;
                continue;
            }
            if (ch === '"')
                inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    let cleaned = '';
    inString = false;
    for (let j = 0; j < out.length; j++) {
        const ch = out[j];
        if (inString) {
            cleaned += ch;
            if (ch === '\\') {
                cleaned += out[j + 1] ?? '';
                j++;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            cleaned += ch;
            continue;
        }
        if (ch === ',') {
            let k = j + 1;
            while (k < out.length && /\s/.test(out[k]))
                k++;
            if (out[k] === '}' || out[k] === ']')
                continue;
        }
        cleaned += ch;
    }
    return JSON.parse(cleaned);
}
//# sourceMappingURL=jsonc.js.map