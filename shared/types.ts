// Shared types used by the extension, the Tauri app and the CLI scripts.

export type SendMode = 'paste' | 'paste+send' | 'newChat+send';
export const SEND_MODES: SendMode[] = ['paste', 'paste+send', 'newChat+send'];

export type Step =
  | { command: string; args?: unknown; optional?: boolean }
  | { keys: string }
  | { terminal: string; name?: string }
  | { shell: string }
  | { prompt: string; mode?: SendMode }
  | { chat: 'focus' | 'newChat' | 'send' }
  | { browser: 'focusOrNew' | 'new' }
  | { delay: number }
  | { notify: string };

export type Action =
  | { label: string; steps: Step[] }
  | { label: string; cycle: string; do: 'next' | 'prev' | 'select' };

export type CycleDef =
  | { label: string; source: 'prompts' }
  | { label: string; source: 'sendModes' }
  | { label: string; source: 'gitBranches'; count?: number }
  /** Models enabled in Cursor Settings → Models (read live from Cursor state). */
  | { label: string; source: 'cursorModels'; applyOnNavigate?: boolean; includeAuto?: boolean }
  | { label: string; source: 'list'; applyOnNavigate?: boolean; items: { label: string; steps: Step[] }[] };

export interface Config {
  bridge: { port: number; tokenFile: string };
  defaults: { sendMode: SendMode; afterKeysDelayMs: number; beforeSendDelayMs: number };
  chat: { focus: Step[]; newChat: Step[]; send: Step[] };
  promptsDir: string;
  cycles: Record<string, CycleDef>;
  inputs: Record<string, Action>;
}

export interface Prompt { id: string; title: string; body: string }

export type Orientation = 0 | 90 | 180 | 270;

export interface LayerDef {
  n: number;
  name: string;
  app: string;
  vscode: string;
}

export const LED_MODE_NAMES = ['off', 'static', 'reactive', 'ripple', 'rainbowRows', 'rainbowCols'] as const;
export type LedModeName = typeof LED_MODE_NAMES[number];

export const LED_MODE_BYTE: Record<LedModeName, number> = {
  off: 0, static: 1, reactive: 2, ripple: 3, rainbowRows: 4, rainbowCols: 5,
};

export const LED_MODE_LABEL: Record<LedModeName, string> = {
  off: 'Off', static: 'Static', reactive: 'Reactive', ripple: 'Ripple',
  rainbowRows: 'Rainbow rows', rainbowCols: 'Rainbow cols',
};

export const STARTUP_PRESETS = ['sweep', 'rainbowChase', 'sparkle', 'pulse'] as const;
export type StartupPreset = typeof STARTUP_PRESETS[number];

export interface LayerLightingConfig {
  mode: LedModeName;
  color?: string;
  keys?: Record<string, string>;
}

export interface StartupConfig {
  enabled: boolean;
  preset: StartupPreset;
  durationMs: number;
  fps: number;
}

export interface LightingConfig {
  layers?: Record<string, LayerLightingConfig>;
  startup?: StartupConfig;
  /** Override which firmware LED slot each physical key uses. Slot n-1 by default. */
  ledSlots?: Record<number, number>;
}

/** Wire format matching Rust's LayerLighting struct. */
export interface LayerLighting {
  layer: number;
  mode: number;
  base: [number, number, number];
  keys: [number, number, number][];
}

export interface DeviceConfig {
  orientation: Orientation;
  layers: LayerDef[];
  physicalRows: number[][];
  appOnly: Record<string, string>;
  lighting?: LightingConfig;
  /**
   * Measured firmware key id for each knob action, keyed "small.left", "big.press", …
   * Written by the knob finder; when missing, ids are guessed from the knob order.
   */
  knobSlots?: Record<string, number>;
}
