import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useMacropadStore } from "@/stores/macropad";
import { allInputs } from "@shared/scheme";

export interface ProgramResult {
  keys_written: number;
  knobs_written: number;
  leds_written: number;
  saved: boolean;
}

interface KeyBinding {
  layer: number;
  input: number;
  is_knob: boolean;
  modifiers: number;
  keycode: number;
  is_media: boolean;
  media_code: number;
  key_id?: number;
}

const MOD = { ctrl: 0x01, shift: 0x02, alt: 0x04, gui: 0x08 } as const;
const MEDIA_VOLUME_UP = 0x00e9;
const MEDIA_VOLUME_DOWN = 0x00ea;
const MEDIA_MUTE = 0x00e2;

function parseModifiers(vscodeMods: string): number {
  let mask = 0;
  for (const p of vscodeMods.toLowerCase().split("+")) {
    if (p === "ctrl") mask |= MOD.ctrl;
    else if (p === "shift") mask |= MOD.shift;
    else if (p === "alt") mask |= MOD.alt;
    else if (p === "cmd") mask |= MOD.gui;
  }
  return mask;
}

function letterToKeycode(letter: string): number {
  if (letter.length === 1 && letter >= "a" && letter <= "z")
    return letter.charCodeAt(0) - "a".charCodeAt(0) + 4;
  return 0;
}

// Module-level so the header button and the Device tab share one state.
const programming = ref(false);
const result = ref<ProgramResult | null>(null);
const error = ref("");
const programmedAt = ref<number | null>(null);

export function usePadProgrammer() {
  const store = useMacropadStore();

  function buildBindings(): KeyBinding[] {
    if (!store.deviceConfig) return [];
    const device = store.deviceConfig;
    const bindings: KeyBinding[] = [];
    const knobDirOffset: Record<string, number> = { left: 0, press: 1, right: 2 };
    const knobBaseOffset: Record<string, number> = { small: 0, mid: 3, big: 6 };
    const knobKeyId = (k: { knob: { id: string }; dir: string }) => device.knobSlots?.[`${k.knob.id}.${k.dir}`];

    for (const inp of allInputs(device)) {
      const appOnlyLabel = device.appOnly[inp.inputId];
      if (appOnlyLabel) {
        let mediaCode = 0;
        if (appOnlyLabel.includes("Volume") && appOnlyLabel.includes("−")) mediaCode = MEDIA_VOLUME_DOWN;
        else if (appOnlyLabel.includes("Volume") && appOnlyLabel.includes("+")) mediaCode = MEDIA_VOLUME_UP;
        else if (appOnlyLabel.includes("Mute")) mediaCode = MEDIA_MUTE;

        if (mediaCode && inp.kind === "knob") {
          const k = inp.k as { knob: { id: string }; dir: string };
          bindings.push({
            layer: inp.layer.n,
            input: knobBaseOffset[k.knob.id] + knobDirOffset[k.dir],
            is_knob: true,
            modifiers: 0,
            keycode: 0,
            is_media: true,
            media_code: mediaCode,
            key_id: knobKeyId(k),
          });
        }
        continue;
      }

      const mods = parseModifiers(inp.layer.vscode);
      const keycode = letterToKeycode((inp.k as { letter: string }).letter);

      if (inp.kind === "key") {
        bindings.push({
          layer: inp.layer.n,
          input: (inp.k as { appKey: number }).appKey,
          is_knob: false,
          modifiers: mods,
          keycode,
          is_media: false,
          media_code: 0,
        });
      } else {
        const k = inp.k as { knob: { id: string }; dir: string };
        bindings.push({
          layer: inp.layer.n,
          input: knobBaseOffset[k.knob.id] + knobDirOffset[k.dir],
          is_knob: true,
          modifiers: mods,
          keycode,
          is_media: false,
          media_code: 0,
          key_id: knobKeyId(k),
        });
      }
    }
    return bindings;
  }

  const bindingCount = computed(() => {
    const b = buildBindings();
    return {
      keys: b.filter((x) => !x.is_knob).length,
      knobs: b.filter((x) => x.is_knob).length,
      total: b.length,
    };
  });

  async function program(): Promise<boolean> {
    if (programming.value) return false;
    programming.value = true;
    error.value = "";
    result.value = null;
    try {
      result.value = await invoke<ProgramResult>("device_program", {
        bindingsJson: JSON.stringify(buildBindings()),
      });
      programmedAt.value = Date.now();
      return true;
    } catch (e) {
      error.value = String(e);
      return false;
    } finally {
      programming.value = false;
    }
  }

  return { programming, result, error, programmedAt, bindingCount, program };
}
