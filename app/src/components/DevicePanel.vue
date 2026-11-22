<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useMacropadStore } from "@/stores/macropad";
import { usePadProgrammer } from "@/composables/usePadProgrammer";
import KnobFinder from "@/components/KnobFinder.vue";
import {
  deviceSetLighting,
  devicePlayFrames,
  onDeviceConnected,
  onDeviceDisconnected,
  onLightingSequenceFinished,
} from "@/api";
import {
  buildAllLighting,
  buildLayerLighting,
  generateStartupFrames,
  hexToRgb,
  rgbToHex,
} from "@shared/lighting";
import type {
  LedModeName,
  StartupPreset,
  LayerLightingConfig,
  LayerLighting,
} from "@shared/types";
import {
  LED_MODE_NAMES,
  LED_MODE_BYTE,
  LED_MODE_LABEL,
  STARTUP_PRESETS,
} from "@shared/types";

interface DeviceInfo {
  vendor_id: number;
  product_id: number;
  product_name: string;
  serial: string;
  connected: boolean;
}

interface DeviceState {
  bindings: unknown[];
  lighting: unknown[];
  programmed_at: string | null;
}

const store = useMacropadStore();
const {
  programming,
  result,
  error: programError,
  programmedAt,
  bindingCount,
  program: runProgram,
} = usePadProgrammer();
const info = ref<DeviceInfo | null>(null);
const state = ref<DeviceState | null>(null);
const applyingLighting = ref(false);
const playingStartup = ref(false);
const error = ref("");
const lightingResult = ref<string | null>(null);
const testResult = ref<string | null>(null);
const testError = ref<string | null>(null);

onMounted(detect);

const unlisteners: (() => void)[] = [];
onMounted(async () => {
  unlisteners.push(await onDeviceConnected(detect));
  unlisteners.push(await onDeviceDisconnected(detect));
  unlisteners.push(
    await onLightingSequenceFinished((p) => {
      playingStartup.value = false;
      if (!p.ok) error.value = p.error ?? "Startup sequence failed";
    }),
  );
});
onUnmounted(() => unlisteners.forEach((u) => u()));

async function detect() {
  error.value = "";
  try {
    info.value = await invoke<DeviceInfo>("device_detect");
    state.value = await invoke<DeviceState>("device_state");
  } catch (e) {
    error.value = String(e);
  }
}

// ---- Lighting config from device.jsonc ----

function getLayerLighting(layerN: number): LayerLightingConfig {
  return (
    store.deviceConfig?.lighting?.layers?.[String(layerN)] ?? {
      mode: "off" as LedModeName,
    }
  );
}

async function setLayerMode(layerN: number, mode: LedModeName) {
  await store.editDeviceConfig(
    ["lighting", "layers", String(layerN), "mode"],
    mode,
  );
}

async function setLayerColor(layerN: number, hex: string) {
  await store.editDeviceConfig(
    ["lighting", "layers", String(layerN), "color"],
    hex,
  );
}

// Startup config
const startupEnabled = computed(
  () => store.deviceConfig?.lighting?.startup?.enabled ?? false,
);
const startupPreset = computed(
  () => store.deviceConfig?.lighting?.startup?.preset ?? "sweep",
);
const startupDuration = computed(
  () => store.deviceConfig?.lighting?.startup?.durationMs ?? 2500,
);
const startupFps = computed(
  () => store.deviceConfig?.lighting?.startup?.fps ?? 12,
);

async function setStartupEnabled(v: boolean) {
  await store.editDeviceConfig(["lighting", "startup", "enabled"], v);
}
async function setStartupPreset(p: string) {
  await store.editDeviceConfig(["lighting", "startup", "preset"], p);
}
async function setStartupDuration(ms: number) {
  await store.editDeviceConfig(["lighting", "startup", "durationMs"], ms);
}
async function setStartupFps(fps: number) {
  await store.editDeviceConfig(["lighting", "startup", "fps"], fps);
}

// ---- Apply lighting ----

async function applyLighting() {
  if (!store.deviceConfig) return;
  applyingLighting.value = true;
  error.value = "";
  lightingResult.value = null;
  try {
    const layers = buildAllLighting(store.deviceConfig);
    const count = await deviceSetLighting(JSON.stringify(layers));
    lightingResult.value = `Applied lighting to ${count} layer(s).`;
    await detect();
  } catch (e) {
    error.value = String(e);
  } finally {
    applyingLighting.value = false;
  }
}

// ---- Startup preview ----

async function previewStartup() {
  if (!store.deviceConfig) return;
  playingStartup.value = true;
  error.value = "";
  try {
    const frames = generateStartupFrames(
      store.deviceConfig,
      startupPreset.value as StartupPreset,
      startupDuration.value,
      startupFps.value,
    );
    const restore = buildAllLighting(store.deviceConfig);
    const frameMs = Math.round(1000 / startupFps.value);
    await devicePlayFrames(
      JSON.stringify(frames),
      frameMs,
      JSON.stringify(restore),
    );
  } catch (e) {
    error.value = String(e);
    playingStartup.value = false;
  }
}

// ---- Hardware test: send a single test pattern ----

async function testStaticRed() {
  testError.value = null;
  testResult.value = null;
  try {
    const layer: LayerLighting = {
      layer: 0,
      mode: LED_MODE_BYTE.static,
      base: [255, 0, 0],
      keys: Array(16).fill([255, 0, 0]),
    };
    await deviceSetLighting(JSON.stringify([layer]));
    testResult.value = "Sent static red to layer 1. Do you see red LEDs?";
  } catch (e) {
    testError.value = String(e);
  }
}

async function testGradient() {
  testError.value = null;
  testResult.value = null;
  try {
    const keys: [number, number, number][] = Array.from(
      { length: 16 },
      (_, i) => {
        const hue = (i / 16) * 360;
        const c = (1 - Math.abs(2 * 0.5 - 1)) * 1;
        const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
        const m = 0.5 - c / 2;
        let r = 0,
          g = 0,
          b = 0;
        if (hue < 60) {
          r = c;
          g = x;
        } else if (hue < 120) {
          r = x;
          g = c;
        } else if (hue < 180) {
          g = c;
          b = x;
        } else if (hue < 240) {
          g = x;
          b = c;
        } else if (hue < 300) {
          r = x;
          b = c;
        } else {
          r = c;
          b = x;
        }
        return [
          Math.round((r + m) * 255),
          Math.round((g + m) * 255),
          Math.round((b + m) * 255),
        ] as [number, number, number];
      },
    );
    const layer: LayerLighting = { layer: 0, mode: 1, base: [0, 0, 0], keys };
    await deviceSetLighting(JSON.stringify([layer]));
    testResult.value =
      "Sent 16-slot rainbow gradient to layer 1. Which keys lit up with which colour?";
  } catch (e) {
    testError.value = String(e);
  }
}

async function testAllModes() {
  testError.value = null;
  testResult.value = null;
  try {
    for (const modeName of LED_MODE_NAMES) {
      if (modeName === "off") continue;
      const mode = LED_MODE_BYTE[modeName];
      const layer: LayerLighting = {
        layer: 0,
        mode,
        base: [59, 130, 246],
        keys: Array(16).fill([59, 130, 246]),
      };
      await deviceSetLighting(JSON.stringify([layer]));
      await new Promise((r) => setTimeout(r, 1500));
    }
    testResult.value =
      "Cycled through all modes. Did you see: static, reactive, ripple, rainbow-rows, rainbow-cols?";
  } catch (e) {
    testError.value = String(e);
  }
}

async function testOff() {
  testError.value = null;
  testResult.value = null;
  try {
    const layers = [0, 1, 2].map((i) => ({
      layer: i,
      mode: 0,
      base: [0, 0, 0] as [number, number, number],
      keys: Array(16).fill([0, 0, 0]),
    }));
    await deviceSetLighting(JSON.stringify(layers));
    testResult.value = "Sent 'off' to all layers.";
  } catch (e) {
    testError.value = String(e);
  }
}

// ---- Key binding programming (shared with the header button) ----

const program = runProgram;
watch(programmedAt, () => {
  void detect();
});
</script>

<template>
  <div class="p-6 max-w-lg space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold">Device</h2>
      <button
        @click="detect"
        class="text-xs text-[var(--accent)] hover:underline"
      >
        Refresh
      </button>
    </div>

    <!-- Connection status -->
    <div
      class="p-4 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)]"
    >
      <div class="flex items-center gap-3">
        <div
          class="w-3 h-3 rounded-full"
          :class="
            info?.connected ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'
          "
        />
        <div>
          <div class="text-sm font-medium">
            {{ info?.connected ? info.product_name : "Not connected" }}
          </div>
          <div
            v-if="info?.connected"
            class="text-xs text-[var(--text-muted)] mt-0.5"
          >
            VID: 0x{{
              info.vendor_id.toString(16).padStart(4, "0").toUpperCase()
            }}
            PID: 0x{{
              info.product_id.toString(16).padStart(4, "0").toUpperCase()
            }}
            <span v-if="info.serial"> · {{ info.serial }}</span>
          </div>
          <div v-else class="text-xs text-[var(--text-muted)] mt-0.5">
            Plug in the macropad via USB to program it.
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Lighting config ===== -->
    <div v-if="info?.connected" class="space-y-3">
      <h3
        class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide"
      >
        Lighting
      </h3>

      <div
        v-for="l in store.deviceConfig?.layers ?? []"
        :key="l.n"
        class="p-3 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)] space-y-3"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium">
            Layer {{ l.n }}
            <span class="text-[var(--text-muted)]"> · {{ l.name }}</span>
          </span>
          <select
            :value="getLayerLighting(l.n).mode"
            @change="
              setLayerMode(
                l.n,
                ($event.target as HTMLSelectElement).value as LedModeName,
              )
            "
            class="text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] outline-none focus:border-[var(--accent)]"
          >
            <option v-for="m in LED_MODE_NAMES" :key="m" :value="m">
              {{ LED_MODE_LABEL[m] }}
            </option>
          </select>
        </div>

        <!-- Colour picker (hidden when Off or Rainbow) -->
        <div
          v-if="
            getLayerLighting(l.n).mode !== 'off' &&
            getLayerLighting(l.n).mode !== 'rainbowRows' &&
            getLayerLighting(l.n).mode !== 'rainbowCols'
          "
          class="flex items-center gap-3"
        >
          <label class="flex items-center gap-2 cursor-pointer">
            <div
              class="w-7 h-7 rounded border border-[var(--border)] overflow-hidden shrink-0"
              :style="{
                backgroundColor: getLayerLighting(l.n).color || '#3b82f6',
              }"
            >
              <input
                type="color"
                :value="getLayerLighting(l.n).color || '#3b82f6'"
                @change="
                  setLayerColor(l.n, ($event.target as HTMLInputElement).value)
                "
                class="opacity-0 w-full h-full cursor-pointer"
              />
            </div>
            <span class="text-xs text-[var(--text-muted)] font-mono uppercase">
              {{ getLayerLighting(l.n).color || "#3b82f6" }}
            </span>
          </label>
        </div>

        <!-- Preview swatch -->
        <div
          v-if="getLayerLighting(l.n).mode !== 'off'"
          class="h-1.5 rounded-full overflow-hidden"
          :style="{
            background:
              getLayerLighting(l.n).mode === 'rainbowRows' ||
              getLayerLighting(l.n).mode === 'rainbowCols'
                ? 'linear-gradient(90deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7, #ef4444)'
                : getLayerLighting(l.n).color || '#3b82f6',
          }"
          :class="{
            'animate-pulse': getLayerLighting(l.n).mode === 'reactive',
          }"
        />
      </div>

      <!-- Apply lighting button -->
      <button
        @click="applyLighting"
        :disabled="applyingLighting"
        class="px-4 py-2 text-sm rounded font-medium transition-colors bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
      >
        {{ applyingLighting ? "Applying…" : "Apply lighting" }}
      </button>

      <div
        v-if="lightingResult"
        class="text-xs px-3 py-2 rounded bg-green-500/10 text-[var(--success)]"
      >
        {{ lightingResult }}
      </div>
    </div>

    <!-- ===== Startup animation ===== -->
    <div v-if="info?.connected" class="space-y-3">
      <h3
        class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide"
      >
        Startup animation
      </h3>

      <div
        class="p-3 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)] space-y-3"
      >
        <label class="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            :checked="startupEnabled"
            @change="
              setStartupEnabled(($event.target as HTMLInputElement).checked)
            "
            class="accent-[var(--accent)]"
          />
          Play animation on connect
        </label>

        <div v-if="startupEnabled" class="space-y-2">
          <div class="flex items-center gap-3">
            <label class="text-xs text-[var(--text-muted)] shrink-0"
              >Preset</label
            >
            <select
              :value="startupPreset"
              @change="
                setStartupPreset(($event.target as HTMLSelectElement).value)
              "
              class="text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option v-for="p in STARTUP_PRESETS" :key="p" :value="p">
                {{ p }}
              </option>
            </select>
          </div>

          <div class="flex items-center gap-3">
            <label class="text-xs text-[var(--text-muted)] shrink-0 w-16"
              >Duration</label
            >
            <input
              type="range"
              min="500"
              max="8000"
              step="100"
              :value="startupDuration"
              @change="
                setStartupDuration(
                  Number(($event.target as HTMLInputElement).value),
                )
              "
              class="flex-1 h-1 accent-[var(--accent)] cursor-pointer"
            />
            <span
              class="text-xs text-[var(--text-muted)] w-14 text-right font-mono"
            >
              {{ (startupDuration / 1000).toFixed(1) }}s
            </span>
          </div>

          <div class="flex items-center gap-3">
            <label class="text-xs text-[var(--text-muted)] shrink-0 w-16"
              >FPS</label
            >
            <input
              type="range"
              min="4"
              max="24"
              step="1"
              :value="startupFps"
              @change="
                setStartupFps(Number(($event.target as HTMLInputElement).value))
              "
              class="flex-1 h-1 accent-[var(--accent)] cursor-pointer"
            />
            <span
              class="text-xs text-[var(--text-muted)] w-14 text-right font-mono"
            >
              {{ startupFps }} fps
            </span>
          </div>

          <button
            @click="previewStartup"
            :disabled="playingStartup"
            class="text-xs px-3 py-1.5 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)] transition-colors disabled:opacity-50"
          >
            {{ playingStartup ? "Playing…" : "Preview" }}
          </button>
        </div>
      </div>
    </div>

    <!-- ===== Hardware test block ===== -->
    <div v-if="info?.connected" class="space-y-3">
      <h3
        class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide"
      >
        Lighting test
      </h3>
      <div
        class="p-3 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)] space-y-2"
      >
        <p class="text-xs text-[var(--text-muted)]">
          Run these tests to verify how the LED protocol works on your pad.
          Results help calibrate slot mapping and confirm mode support.
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            @click="testStaticRed"
            class="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)]"
          >
            1. Static red
          </button>
          <button
            @click="testGradient"
            class="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)]"
          >
            2. Slot gradient
          </button>
          <button
            @click="testAllModes"
            class="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)]"
          >
            3. All modes
          </button>
          <button
            @click="testOff"
            class="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)]"
          >
            4. Off
          </button>
        </div>
        <div
          v-if="testResult"
          class="text-xs px-3 py-2 rounded bg-blue-500/10 text-[var(--accent)]"
        >
          {{ testResult }}
        </div>
        <div
          v-if="testError"
          class="text-xs px-3 py-2 rounded bg-red-500/10 text-[var(--error)]"
        >
          {{ testError }}
        </div>
      </div>
    </div>

    <!-- ===== Key bindings programming ===== -->
    <div
      v-if="info?.connected"
      class="space-y-3 pt-2 border-t border-[var(--border)]"
    >
      <h3
        class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide"
      >
        Key bindings
      </h3>
      <div class="text-xs text-[var(--text-muted)]">
        Will program <strong>{{ bindingCount.keys }}</strong> keys and
        <strong>{{ bindingCount.knobs }}</strong> knob inputs across
        {{ store.deviceConfig?.layers?.length ?? 0 }} layers ({{
          bindingCount.total
        }}
        bindings total).
      </div>

      <button
        @click="program"
        :disabled="programming"
        class="px-4 py-2 text-sm rounded font-medium transition-colors bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
      >
        {{ programming ? "Programming…" : "Program pad" }}
      </button>
    </div>

    <KnobFinder v-if="info?.connected" />

    <!-- Last programmed -->
    <div v-if="state?.programmed_at" class="text-xs text-[var(--text-muted)]">
      Last programmed: {{ state.programmed_at }} ({{
        state.bindings?.length ?? 0
      }}
      bindings)
    </div>

    <!-- Success -->
    <div
      v-if="result"
      class="text-xs px-3 py-2 rounded bg-green-500/10 text-[var(--success)]"
    >
      Programmed {{ result.keys_written }} keys,
      {{ result.knobs_written }} knobs. Saved to flash.
    </div>

    <!-- Error -->
    <div
      v-if="error || programError"
      class="text-xs px-3 py-2 rounded bg-red-500/10 text-[var(--error)]"
    >
      {{ error || programError }}
    </div>

    <!-- Info -->
    <div
      class="text-xs text-[var(--text-muted)] space-y-2 pt-2 border-t border-[var(--border)]"
    >
      <p>
        <strong>Lighting</strong> is applied separately from key bindings.
        Changes to modes and colours take effect immediately when you click
        "Apply lighting".
      </p>
      <p>
        <strong>Key bindings</strong> are written to flash. After programming,
        the pad works over both USB and Bluetooth. Changing what a key
        <em>does</em> only needs a config edit — no reprogramming required.
      </p>
    </div>
  </div>
</template>
