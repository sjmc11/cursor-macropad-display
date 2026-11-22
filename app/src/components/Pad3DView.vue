<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import { usePadScene } from "@/composables/usePadScene";
import ActionEditor from "./ActionEditor.vue";
import type { LayerLightingConfig } from "@shared/types";

const store = useMacropadStore();
const canvasRef = ref<HTMLElement | null>(null);
const activeLayer = ref(1);

const physicalRows = computed(
  () =>
    store.deviceConfig?.physicalRows ?? [
      [9, 5, 1],
      [10, 6, 2],
      [11, 7, 3],
      [12, 8, 4],
    ],
);

const scene = usePadScene(canvasRef, physicalRows);

const selectedInputId = computed(() => {
  if (!scene.selectedPart.value) return null;
  return `L${activeLayer.value}.${scene.selectedPart.value}`;
});

const tooltipLabel = computed(() => {
  if (!scene.hoveredPart.value) return null;
  const partId = scene.hoveredPart.value;
  const zone = scene.hoveredZone.value;
  const suffix = zone ? `.${zone}` : "";
  const inputId = `L${activeLayer.value}.${partId}${suffix}`;
  const action = store.config?.inputs?.[inputId] as
    | { label?: string }
    | undefined;
  return action?.label ?? inputId;
});

function layerLighting(layerN: number): LayerLightingConfig | undefined {
  return store.deviceConfig?.lighting?.layers?.[String(layerN)];
}

// Orientation — apply immediately and whenever it changes
watch(
  () => store.orientation,
  (o) => {
    if (o !== undefined) scene.setOrientation(o);
  },
  { immediate: true },
);

// LED colours — apply on layer change, lighting config change, or first load
watch(
  [activeLayer, () => store.deviceConfig?.lighting],
  () => scene.updateColors(layerLighting(activeLayer.value)),
  { immediate: true, deep: true },
);

// Hardware press — animate the matching key/knob and auto-switch layer
watch(
  () => store.lastInput,
  (li) => {
    if (!li) return;
    const layer = Number(/^L(\d+)\./.exec(li.id)?.[1]);
    if (layer) activeLayer.value = layer;
    scene.pressInput(li.id);
  },
);

function closeEditor() {
  scene.deselect();
}
</script>

<template>
  <div class="flex flex-col h-full select-none">
    <div
      class="flex items-center gap-4 p-4 shrink-0 border-b border-[var(--border)]"
    >
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

      <button
        @click="scene.resetCamera()"
        class="ml-auto px-3 py-1.5 rounded text-xs font-medium bg-[var(--bg-raised)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
      >
        Reset view
      </button>
    </div>

    <div class="flex-1 flex overflow-hidden">
      <div ref="canvasRef" class="flex-1 relative min-w-0" tabindex="0">
        <div
          v-if="tooltipLabel"
          class="absolute top-4 left-4 px-3 py-1.5 rounded-lg bg-black/70 text-white text-xs font-medium pointer-events-none backdrop-blur-sm"
        >
          {{ tooltipLabel }}
        </div>
      </div>

      <Transition name="panel">
        <div
          v-if="selectedInputId"
          class="w-[400px] shrink-0 border-l border-[var(--border)] bg-[var(--bg-raised)] overflow-hidden"
        >
          <ActionEditor
            :input-id="selectedInputId"
            variant="panel"
            @close="closeEditor"
          />
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.panel-enter-active,
.panel-leave-active {
  transition:
    width 0.25s ease,
    opacity 0.2s ease;
  overflow: hidden;
}
.panel-enter-from,
.panel-leave-to {
  width: 0;
  opacity: 0;
}
</style>
