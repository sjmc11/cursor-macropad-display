// Physical layout and combo generation for the macropad.
// Pure functions — no file I/O, works in both Node and browser.

import { DeviceConfig, LayerDef } from './types';

const letters = 'abcdefghijklmnopqrstu'.split('');

export interface KeyDef { id: string; appKey: number; letter: string }
export interface KnobDef { id: string; appKnob: string; physical: string }
export interface KnobInputDef { id: string; knob: KnobDef; dir: string; letter: string }

export const keys: KeyDef[] = Array.from({ length: 12 }, (_, i) => ({
  id: `K${i + 1}`, appKey: i + 1, letter: letters[i],
}));

export const knobs: KnobDef[] = [
  { id: 'big',   appKnob: 'bottom (big, W)',  physical: 'left (big)' },
  { id: 'mid',   appKnob: 'middle (T)',       physical: 'middle' },
  { id: 'small', appKnob: 'top (Q / Volume)', physical: 'right' },
];

// mid.right would be `q`, which collides with Cmd+Q (Quit); `v` also collides
// with macOS/Electron's Paste and Match Style (Opt+Shift+Cmd+V) in chat inputs.
// `y` has no macOS native menu shortcut with hyper modifiers.
const LETTER_OVERRIDES: Record<string, string> = { 'mid.right': 'y' };

export const knobInputs: KnobInputDef[] = knobs.flatMap((k, ki) =>
  (['left', 'right', 'press'] as const).map((dir, di) => {
    const id = `${k.id}.${dir}`;
    return {
      id, knob: k, dir,
      letter: LETTER_OVERRIDES[id] ?? letters[12 + ki * 3 + di],
    };
  }));

export interface InputInfo {
  inputId: string;
  layer: LayerDef;
  combo: string;
  app: string;
  kind: 'key' | 'knob';
  k: KeyDef | KnobInputDef;
}

/** All logical inputs across all layers, with the key combo each one sends. */
export function allInputs(device: DeviceConfig): InputInfo[] {
  return device.layers.flatMap((l) => [
    ...keys.map((k): InputInfo => ({
      inputId: `L${l.n}.${k.id}`, layer: l,
      combo: `${l.vscode}+${k.letter}`, app: `${l.app} ${k.letter.toUpperCase()}`,
      kind: 'key', k,
    })),
    ...knobInputs.map((k): InputInfo => ({
      inputId: `L${l.n}.${k.id}`, layer: l,
      combo: `${l.vscode}+${k.letter}`, app: `${l.app} ${k.letter.toUpperCase()}`,
      kind: 'knob', k,
    })),
  ]);
}
