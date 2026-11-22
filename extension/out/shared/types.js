"use strict";
// Shared types used by the extension, the Tauri app and the CLI scripts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.STARTUP_PRESETS = exports.LED_MODE_LABEL = exports.LED_MODE_BYTE = exports.LED_MODE_NAMES = exports.SEND_MODES = void 0;
exports.SEND_MODES = ['paste', 'paste+send', 'newChat+send'];
exports.LED_MODE_NAMES = ['off', 'static', 'reactive', 'ripple', 'rainbowRows', 'rainbowCols'];
exports.LED_MODE_BYTE = {
    off: 0, static: 1, reactive: 2, ripple: 3, rainbowRows: 4, rainbowCols: 5,
};
exports.LED_MODE_LABEL = {
    off: 'Off', static: 'Static', reactive: 'Reactive', ripple: 'Ripple',
    rainbowRows: 'Rainbow rows', rainbowCols: 'Rainbow cols',
};
exports.STARTUP_PRESETS = ['sweep', 'rainbowChase', 'sparkle', 'pulse'];
//# sourceMappingURL=types.js.map