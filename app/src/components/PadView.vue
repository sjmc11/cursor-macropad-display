<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import type { Action, Orientation, LayerLightingConfig } from "@shared/types";
import ActionEditor from "./ActionEditor.vue";

const store = useMacropadStore();
const activeLayer = ref(1);
const editingInput = ref<string | null>(null);
const paintMode = ref(false);
const colorPickerKey = ref<string | null>(null);
const colorPickerRef = ref<HTMLInputElement | null>(null);

const orientations: Orientation[] = [0, 90, 180, 270];
const orientationLabels: Record<Orientation, string> = {
  0: "Knobs bottom",
  90: "Knobs left",
  180: "Knobs top",
  270: "Knobs right",
};

function rotateOrientation(dir: 1 | -1) {
  const idx = orientations.indexOf(store.orientation);
  const next = orientations[(idx + dir + 4) % 4];
  store.editDeviceConfig(["orientation"], next);
}

const baseRows = computed(
  () =>
    store.deviceConfig?.physicalRows ?? [
      [9, 5, 1],
      [10, 6, 2],
      [11, 7, 3],
      [12, 8, 4],
    ],
);

const rotatedGrid = computed(() => {
  const rows = baseRows.value;
  const o = store.orientation;
  if (o === 0) return rows;
  if (o === 90) {
    const cols = rows[0].length;
    const result: number[][] = [];
    for (let c = 0; c < cols; c++) {
      result.push(rows.map((r) => r[c]).reverse());
    }
    return result;
  }
  if (o === 180) {
    return [...rows].reverse().map((r) => [...r].reverse());
  }
  const cols = rows[0].length;
  const result: number[][] = [];
  for (let c = cols - 1; c >= 0; c--) {
    result.push(rows.map((r) => r[c]));
  }
  return result;
});

const knobAxis = computed(() => {
  const o = store.orientation;
  return o === 0 || o === 180 ? "horizontal" : "vertical";
});

const padLayoutClass = computed(() => {
  switch (store.orientation) {
    case 90:
      return "flex flex-row-reverse items-center";
    case 180:
      return "flex flex-col-reverse";
    case 270:
      return "flex flex-row items-center";
    default:
      return "flex flex-col";
  }
});

const knobSeparatorClass = computed(() => {
  switch (store.orientation) {
    case 90:
      return "mr-4 pr-4 border-r";
    case 180:
      return "mb-4 pb-4 border-b";
    case 270:
      return "ml-4 pl-4 border-l";
    default:
      return "mt-4 pt-4 border-t";
  }
});

const knobOrder = computed(() => {
  const ids = ["big", "mid", "small"];
  const o = store.orientation;
  if (o === 180 || o === 270) return [...ids].reverse();
  return ids;
});

function getAction(inputId: string): Action | undefined {
  return store.config?.inputs?.[inputId] as Action | undefined;
}

function inputErrors(inputId: string) {
  return store.errors.filter(
    (e) =>
      e.path === `inputs.${inputId}` || e.path.startsWith(`inputs.${inputId}[`),
  );
}

// ---- Lighting colours for key tints ----

function layerLighting(layerN: number): LayerLightingConfig | undefined {
  return store.deviceConfig?.lighting?.layers?.[String(layerN)];
}

function keyColor(keyNum: number): string | null {
  const cfg = layerLighting(activeLayer.value);
  if (!cfg || cfg.mode === "off") return null;
  const perKey = cfg.keys?.[`K${keyNum}`];
  if (perKey) return perKey;
  return cfg.color || null;
}

// ---- Paint mode ----

function handleKeyClick(keyNum: number) {
  if (paintMode.value) {
    colorPickerKey.value = `K${keyNum}`;
    nextTick(() => colorPickerRef.value?.click());
  } else {
    openEditor(`L${activeLayer.value}.K${keyNum}`);
  }
}

function handleKeyContextMenu(e: MouseEvent, keyNum: number) {
  if (!paintMode.value) return;
  e.preventDefault();
  const layerN = activeLayer.value;
  store.editDeviceConfig(
    ["lighting", "layers", String(layerN), "keys", `K${keyNum}`],
    undefined,
  );
}

function onColorPicked(e: Event) {
  const hex = (e.target as HTMLInputElement).value;
  const kid = colorPickerKey.value;
  if (!kid) return;
  const layerN = activeLayer.value;
  store.editDeviceConfig(
    ["lighting", "layers", String(layerN), "keys", kid],
    hex,
  );
  colorPickerKey.value = null;
}

// ---- Flash on key press ----

const flashId = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => store.lastInput,
  (li) => {
    if (li) {
      const layer = Number(/^L(\d+)\./.exec(li.id)?.[1]);
      if (layer) activeLayer.value = layer;
      flashId.value = li.id;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashId.value = null;
      }, 800);
    }
  },
);

// When Studio has focus the pad's chords land here instead of in Cursor.
const comboToInput = computed(() => {
  const map = new Map<string, string>();
  for (const kb of store.getKeybindings()) map.set(kb.key, kb.args);
  return map;
});

function comboFromEvent(e: KeyboardEvent): string | null {
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
  if (!letter) return null;
  const mods = [
    e.ctrlKey && "ctrl",
    e.altKey && "alt",
    e.shiftKey && "shift",
    e.metaKey && "cmd",
  ].filter(Boolean);
  return [...mods, letter].join("+");
}

function onKeydown(e: KeyboardEvent) {
  const combo = comboFromEvent(e);
  const inputId = combo && comboToInput.value.get(combo);
  if (!inputId) return;
  e.preventDefault();
  store.markInput(inputId);
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  clearTimeout(flashTimer);
});

function openEditor(inputId: string) {
  editingInput.value = inputId;
}
function closeEditor() {
  editingInput.value = null;
}
</script>

<template>
  <div class="p-6 max-w-4xl mx-auto">
    <!-- Layer tabs + paint toggle + orientation controls -->
    <div class="flex items-center gap-4 mb-6">
      <div class="flex gap-1">
        <button
          v-for="l in store.deviceConfig?.layers ?? []"
          :key="l.n"
          @click="activeLayer = l.n"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          :class="
            activeLayer === l.n
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] border border-[var(--border)]'
          "
        >
          L{{ l.n }} · {{ l.name }}
        </button>
      </div>

      <!-- Paint mode toggle -->
      <button
        @click="paintMode = !paintMode"
        class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border"
        :class="
          paintMode
            ? 'bg-purple-500/20 text-purple-400 border-purple-500/50'
            : 'bg-[var(--bg-raised)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]'
        "
        title="Toggle paint mode — click keys to set per-key LED colours, right-click to clear"
      >
        🎨 Paint
      </button>

      <div
        class="ml-auto flex items-center gap-2 text-xs text-[var(--text-muted)]"
      >
        <button
          @click="rotateOrientation(-1)"
          class="p-1.5 rounded hover:bg-[var(--bg-hover)]"
          title="Rotate left"
        >
          ↺
        </button>
        <span class="w-24 text-center">{{
          orientationLabels[store.orientation]
        }}</span>
        <button
          @click="rotateOrientation(1)"
          class="p-1.5 rounded hover:bg-[var(--bg-hover)]"
          title="Rotate right"
        >
          ↻
        </button>
      </div>
    </div>

    <!-- Hidden colour picker for paint mode -->
    <input
      ref="colorPickerRef"
      type="color"
      class="absolute opacity-0 pointer-events-none w-0 h-0"
      :value="keyColor(1) ?? '#3b82f6'"
      @input="onColorPicked"
    />

    <!-- Key grid -->
    <div
      class="inline-flex rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)] p-4"
      :class="padLayoutClass"
    >
      <div
        class="grid gap-2"
        :style="{
          gridTemplateColumns: `repeat(${rotatedGrid[0]?.length ?? 3}, minmax(0, 1fr))`,
        }"
      >
        <template v-for="(row, ri) in rotatedGrid" :key="ri">
          <button
            v-for="(keyNum, ci) in row"
            :key="`${ri}-${ci}`"
            @click="handleKeyClick(keyNum)"
            @contextmenu="handleKeyContextMenu($event, keyNum)"
            class="relative w-28 h-20 rounded-xl border text-left p-2 transition-all text-xs cursor-pointer overflow-hidden"
            :class="[
              flashId === `L${activeLayer}.K${keyNum}`
                ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]'
                : 'border-[var(--border)] hover:border-[var(--text-muted)]',
              inputErrors(`L${activeLayer}.K${keyNum}`).some(
                (e) => e.level === 'error',
              )
                ? '!border-[var(--error)]'
                : '',
              paintMode ? 'cursor-crosshair' : '',
            ]"
            :style="{
              backgroundColor: keyColor(keyNum)
                ? keyColor(keyNum)! + '20'
                : flashId === `L${activeLayer}.K${keyNum}`
                  ? 'var(--accent-bg, rgba(59,130,246,0.1))'
                  : 'var(--bg)',
            }"
          >
            <!-- Colour indicator strip -->
            <div
              v-if="keyColor(keyNum)"
              class="absolute bottom-0 left-0 right-0 h-1"
              :style="{ backgroundColor: keyColor(keyNum)! }"
            />

            <div class="font-medium truncate leading-tight">
              {{ getAction(`L${activeLayer}.K${keyNum}`)?.label ?? "—" }}
            </div>
            <div class="mt-1 text-[10px] text-[var(--text-muted)]">
              K{{ keyNum }}
            </div>
            <div
              v-if="inputErrors(`L${activeLayer}.K${keyNum}`).length"
              class="absolute top-1 right-1.5 w-2 h-2 rounded-full"
              :class="
                inputErrors(`L${activeLayer}.K${keyNum}`).some(
                  (e) => e.level === 'error',
                )
                  ? 'bg-[var(--error)]'
                  : 'bg-[var(--warning)]'
              "
            />
          </button>
        </template>
      </div>

      <!-- Knobs -->
      <div
        class="border-[var(--border)]"
        :class="[
          knobSeparatorClass,
          knobAxis === 'vertical'
            ? 'flex flex-col gap-3 items-center self-stretch justify-center'
            : 'flex gap-6 justify-center',
        ]"
      >
        <div
          v-for="knobId in knobOrder"
          :key="knobId"
          class="flex items-center gap-2"
        >
          <button
            @click="openEditor(`L${activeLayer}.${knobId}.left`)"
            class="text-[10px] px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)] truncate max-w-20"
            :class="
              flashId === `L${activeLayer}.${knobId}.left`
                ? 'ring-1 ring-[var(--accent)]'
                : ''
            "
            :title="getAction(`L${activeLayer}.${knobId}.left`)?.label ?? '←'"
          >
            {{ getAction(`L${activeLayer}.${knobId}.left`)?.label ?? "←" }}
          </button>
          <button
            @click="openEditor(`L${activeLayer}.${knobId}.press`)"
            class="rounded-full border-2 border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)] flex flex-col items-center justify-center text-[10px] font-medium transition-colors"
            :class="[
              flashId === `L${activeLayer}.${knobId}.press`
                ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]'
                : '',
              knobId === 'big'
                ? 'w-16 h-16'
                : knobId === 'small'
                  ? 'w-11 h-11'
                  : 'w-14 h-14',
            ]"
          >
            <span class="truncate max-w-full px-1">{{
              getAction(`L${activeLayer}.${knobId}.press`)?.label ?? "⏎"
            }}</span>
            <span class="text-[8px] text-[var(--text-muted)]">{{
              knobId
            }}</span>
          </button>
          <button
            @click="openEditor(`L${activeLayer}.${knobId}.right`)"
            class="text-[10px] px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--text-muted)] bg-[var(--bg)] truncate max-w-20"
            :class="
              flashId === `L${activeLayer}.${knobId}.right`
                ? 'ring-1 ring-[var(--accent)]'
                : ''
            "
            :title="getAction(`L${activeLayer}.${knobId}.right`)?.label ?? '→'"
          >
            {{ getAction(`L${activeLayer}.${knobId}.right`)?.label ?? "→" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Paint mode hint -->
    <p v-if="paintMode" class="mt-3 text-xs text-purple-400">
      Click a key to set its LED colour. Right-click to clear it back to the
      layer colour. Colours are saved to <code>device.jsonc</code> — apply them
      on the Device tab.
    </p>

    <!-- Action editor modal -->
    <ActionEditor
      v-if="editingInput"
      :input-id="editingInput"
      @close="closeEditor"
    />
  </div>
</template>
