<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import { usePadProgrammer } from "@/composables/usePadProgrammer";
import PadView from "@/components/PadView.vue";
import PromptsView from "@/components/PromptsView.vue";
import CyclesView from "@/components/CyclesView.vue";
import SettingsView from "@/components/SettingsView.vue";
import CursorPanel from "@/components/CursorPanel.vue";
import DevicePanel from "@/components/DevicePanel.vue";
import Pad3DView from "@/components/Pad3DView.vue";

const store = useMacropadStore();
const {
  programming,
  result,
  error: programError,
  programmedAt,
  bindingCount,
  program,
} = usePadProgrammer();

const justProgrammed = ref(false);
let programmedTimer: ReturnType<typeof setTimeout> | undefined;
watch(programmedAt, () => {
  justProgrammed.value = true;
  clearTimeout(programmedTimer);
  programmedTimer = setTimeout(() => {
    justProgrammed.value = false;
  }, 4000);
});

const tab = ref<
  "pad" | "pad3d" | "prompts" | "cycles" | "settings" | "cursor" | "device"
>("pad");

const tabs = [
  { id: "pad" as const, label: "Pad" },
  { id: "pad3d" as const, label: "3D" },
  { id: "prompts" as const, label: "Prompts" },
  { id: "cycles" as const, label: "Cycles" },
  { id: "settings" as const, label: "Settings" },
  { id: "cursor" as const, label: "Cursor" },
  { id: "device" as const, label: "Device" },
];

onMounted(async () => {
  await store.load();
  store.setupWatcher();
});
</script>

<template>
  <div class="flex flex-col h-screen">
    <!-- Top bar -->
    <header
      class="flex items-center gap-4 px-4 h-12 border-b border-[var(--border)] bg-[var(--bg-raised)] shrink-0 select-none"
    >
      <span class="font-semibold text-sm tracking-wide opacity-80"
        >Macropad Studio</span
      >
      <nav class="flex gap-1 ml-4">
        <button
          v-for="t in tabs"
          :key="t.id"
          @click="tab = t.id"
          class="px-3 py-1.5 rounded text-xs font-medium transition-colors"
          :class="
            tab === t.id
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]'
          "
        >
          {{ t.label }}
        </button>
      </nav>
      <div class="ml-auto flex items-center gap-3">
        <span
          class="text-xs text-[var(--text-muted)]"
          v-if="store.errors.filter((e) => e.level === 'error').length"
        >
          {{ store.errors.filter((e) => e.level === "error").length }} error(s)
        </span>
        <span
          v-if="programError"
          class="text-xs text-[var(--error)] max-w-64 truncate"
          :title="programError"
        >
          {{ programError }}
        </span>
        <span v-else-if="justProgrammed" class="text-xs text-[var(--success)]">
          Programmed {{ result?.keys_written }} keys,
          {{ result?.knobs_written }} knobs
        </span>
        <button
          @click="program"
          :disabled="programming || store.loading"
          :title="`Write ${bindingCount.total} key/knob bindings to the pad's flash`"
          class="px-3 py-1.5 rounded text-xs font-medium transition-colors bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {{ programming ? "Programming…" : "Program pad" }}
        </button>
      </div>
    </header>

    <!-- Loading state -->
    <div
      v-if="store.loading"
      class="flex-1 flex items-center justify-center text-[var(--text-muted)]"
    >
      Loading…
    </div>

    <!-- Content -->
    <main
      v-else
      class="flex-1 overflow-auto"
      :class="{ 'overflow-hidden': tab === 'pad3d' }"
    >
      <PadView v-if="tab === 'pad'" />
      <Pad3DView v-else-if="tab === 'pad3d'" />
      <PromptsView v-else-if="tab === 'prompts'" />
      <CyclesView v-else-if="tab === 'cycles'" />
      <SettingsView v-else-if="tab === 'settings'" />
      <CursorPanel v-else-if="tab === 'cursor'" />
      <DevicePanel v-else-if="tab === 'device'" />
    </main>
  </div>
</template>
