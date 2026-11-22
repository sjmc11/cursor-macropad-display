"use strict";
// Physical layout and combo generation for the macropad.
// Pure functions — no file I/O, works in both Node and browser.
Object.defineProperty(exports, "__esModule", { value: true });
exports.knobInputs = exports.knobs = exports.keys = void 0;
exports.allInputs = allInputs;
const letters = 'abcdefghijklmnopqrstu'.split('');
exports.keys = Array.from({ length: 12 }, (_, i) => ({
    id: `K${i + 1}`, appKey: i + 1, letter: letters[i],
}));
exports.knobs = [
    { id: 'big', appKnob: 'bottom (big, W)', physical: 'left (big)' },
    { id: 'mid', appKnob: 'middle (T)', physical: 'middle' },
    { id: 'small', appKnob: 'top (Q / Volume)', physical: 'right' },
];
// mid.right would be `q`, which collides with Cmd+Q (Quit); `v` also collides
// with macOS/Electron's Paste and Match Style (Opt+Shift+Cmd+V) in chat inputs.
// `y` has no macOS native menu shortcut with hyper modifiers.
const LETTER_OVERRIDES = { 'mid.right': 'y' };
exports.knobInputs = exports.knobs.flatMap((k, ki) => ['left', 'right', 'press'].map((dir, di) => {
    const id = `${k.id}.${dir}`;
    return {
        id, knob: k, dir,
        letter: LETTER_OVERRIDES[id] ?? letters[12 + ki * 3 + di],
    };
}));
/** All logical inputs across all layers, with the key combo each one sends. */
function allInputs(device) {
    return device.layers.flatMap((l) => [
        ...exports.keys.map((k) => ({
            inputId: `L${l.n}.${k.id}`, layer: l,
            combo: `${l.vscode}+${k.letter}`, app: `${l.app} ${k.letter.toUpperCase()}`,
            kind: 'key', k,
        })),
        ...exports.knobInputs.map((k) => ({
            inputId: `L${l.n}.${k.id}`, layer: l,
            combo: `${l.vscode}+${k.letter}`, app: `${l.app} ${k.letter.toUpperCase()}`,
            kind: 'knob', k,
        })),
    ]);
}
//# sourceMappingURL=scheme.js.map