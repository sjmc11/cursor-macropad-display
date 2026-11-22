<script setup lang="ts">
import { ref, computed } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import type { CycleDef } from "@shared/types";

const store = useMacropadStore();
const selectedCycle = ref<string | null>(null);

const cycleEntries = computed(() => Object.entries(store.config?.cycles ?? {}));

function select(name: string) {
  selectedCycle.value = name;
}

const editing = computed<CycleDef | undefined>(() => {
  if (!selectedCycle.value || !store.config?.cycles) return undefined;
  return store.config.cycles[selectedCycle.value] as CycleDef;
});

async function updateLabel(label: string) {
  if (!selectedCycle.value) return;
  await store.editConfig(["cycles", selectedCycle.value, "label"], label);
}

async function updateSource(source: string) {
  if (!selectedCycle.value) return;
  await store.editConfig(["cycles", selectedCycle.value, "source"], source);
}

async function updateCount(count: number) {
  if (!selectedCycle.value) return;
  await store.editConfig(["cycles", selectedCycle.value, "count"], count || undefined);
}

async function addCycle() {
  const name = prompt("Cycle name (no spaces):");
  if (!name) return;
  await store.editConfig(["cycles", name], { label: name, source: "list", items: [] });
  selectedCycle.value = name;
}

async function removeCycle() {
  if (!selectedCycle.value) return;
  await store.editConfig(["cycles", selectedCycle.value], undefined);
  selectedCycle.value = null;
}
</script>

<template>
  <div class="flex h-full">
    <!-- Sidebar -->
    <div class="w-56 border-r border-[var(--border)] flex flex-col">
      <div class="p-3 border-b border-[var(--border)] flex justify-between items-center">
        <span class="text-xs font-medium text-[var(--text-muted)]">Cycles</span>
        <button @click="addCycle" class="text-xs text-[var(--accent)] hover:underline">+ New</button>
      </div>
      <div class="flex-1 overflow-y-auto">
        <button
          v-for="[name, def] in cycleEntries"
          :key="name"
          @click="select(name)"
          class="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-hover)] transition-colors"
          :class="selectedCycle === name ? 'bg-[var(--bg-hover)] text-[var(--text)]' : 'text-[var(--text-muted)]'"
        >
          <div class="font-medium">{{ (def as CycleDef).label }}</div>
          <div class="text-[10px] opacity-60">{{ name }} · {{ (def as CycleDef).source }}</div>
        </button>
      </div>
    </div>

    <!-- Editor -->
    <div v-if="editing" class="flex-1 p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium">{{ selectedCycle }}</h2>
        <button @click="removeCycle" class="text-xs text-[var(--error)] hover:underline">Delete</button>
      </div>

      <div class="grid grid-cols-2 gap-4 max-w-md">
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">Label</label>
          <input :value="editing.label" @change="updateLabel(($event.target as HTMLInputElement).value)"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]" />
        </div>
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">Source</label>
          <select :value="editing.source" @change="updateSource(($event.target as HTMLSelectElement).value)"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]">
            <option value="prompts">prompts</option>
            <option value="sendModes">sendModes</option>
            <option value="gitBranches">gitBranches</option>
            <option value="cursorModels">cursorModels</option>
            <option value="list">list</option>
          </select>
        </div>
      </div>

      <div v-if="editing.source === 'gitBranches'" class="max-w-md">
        <label class="block text-xs text-[var(--text-muted)] mb-1">Max branches</label>
        <input type="number" :value="(editing as any).count ?? 15"
          @change="updateCount(parseInt(($event.target as HTMLInputElement).value))"
          class="w-24 px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]" />
      </div>

      <div v-if="editing.source === 'cursorModels'" class="text-xs text-[var(--text-muted)] max-w-lg space-y-1">
        <p>Reads the models enabled in <strong>Cursor Settings → Models</strong> (live from Cursor’s state DB).</p>
        <p>Twist applies immediately. Parameter prefs (effort/fast) come from your last choice for each model.</p>
      </div>

      <div v-if="editing.source === 'list'" class="text-xs text-[var(--text-muted)]">
        Custom list items can be edited in config/macropad.jsonc directly for now.
      </div>
    </div>

    <div v-else class="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
      Select a cycle to edit
    </div>
  </div>
</template>
