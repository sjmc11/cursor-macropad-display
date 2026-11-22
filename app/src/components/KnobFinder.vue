<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useMacropadStore } from "@/stores/macropad";
import { usePadProgrammer } from "@/composables/usePadProgrammer";

// Every id from FIRST_ID gets a chord; covers both "knobs after 12 buttons" (13+)
// and "knobs after 16 buttons" (17+) layouts.
const FIRST_ID = 13;
const LAST_ID = 28;
// Layer 1's chord: ctrl+alt+shift+cmd.
const PROBE_MODIFIERS = 0x0f;
// A knob detent can arrive as a quick burst; ignore repeats inside this window.
const REPEAT_MS = 350;

const STEPS = (["small", "mid", "big"] as const).flatMap((knob) =>
  (["left", "press", "right"] as const).map((dir) => ({
    key: `${knob}.${dir}`,
    label: `${{ small: "Small", mid: "Middle", big: "Big" }[knob]} knob: ${
      {
        left: "turn anticlockwise one click",
        press: "press",
        right: "turn clockwise one click",
      }[dir]
    }`,
  })),
);

const store = useMacropadStore();
const { program, programming } = usePadProgrammer();

const phase = ref<"idle" | "probing" | "done">("idle");
const step = ref(0);
const found = ref<Record<string, number>>({});
const error = ref("");
let lastHitAt = 0;

const duplicates = computed(() => {
  const seen = new Map<number, string>();
  const dupes = new Set<string>();
  for (const [k, id] of Object.entries(found.value)) {
    if (seen.has(id)) {
      dupes.add(k);
      dupes.add(seen.get(id)!);
    }
    seen.set(id, k);
  }
  return dupes;
});

function onKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey && e.altKey && e.shiftKey && e.metaKey)) return;
  const m = /^Key([A-Z])$/.exec(e.code);
  if (!m) return;
  const id = FIRST_ID + (m[1].charCodeAt(0) - 65);
  if (id > LAST_ID) return;
  e.preventDefault();
  e.stopPropagation();
  const now = Date.now();
  if (now - lastHitAt < REPEAT_MS) return;
  lastHitAt = now;
  found.value = { ...found.value, [STEPS[step.value].key]: id };
  if (step.value < STEPS.length - 1) step.value++;
  else finish();
}

async function start() {
  error.value = "";
  found.value = {};
  step.value = 0;
  try {
    await invoke("device_probe_slots", {
      layer: 1,
      firstId: FIRST_ID,
      lastId: LAST_ID,
      modifiers: PROBE_MODIFIERS,
    });
  } catch (e) {
    error.value = String(e);
    return;
  }
  phase.value = "probing";
  window.addEventListener("keydown", onKeydown, true);
}

function finish() {
  window.removeEventListener("keydown", onKeydown, true);
  phase.value = "done";
}

function back() {
  if (step.value === 0) return;
  step.value--;
  const { [STEPS[step.value].key]: _, ...rest } = found.value;
  found.value = rest;
}

function skip() {
  if (step.value < STEPS.length - 1) step.value++;
  else finish();
}

async function cancel() {
  window.removeEventListener("keydown", onKeydown, true);
  phase.value = "idle";
  await program();
}

async function saveAndProgram() {
  await store.editDeviceConfig(["knobSlots"], found.value);
  phase.value = "idle";
  await program();
}

onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));
</script>

<template>
  <div class="space-y-3 pt-2 border-t border-[var(--border)]">
    <h3
      class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide"
    >
      Knob finder
    </h3>

    <template v-if="phase === 'idle'">
      <p class="text-xs text-[var(--text-muted)]">
        Works out which firmware slot each knob action uses, so knob bindings
        land on the right knob. Layer 1 knobs are temporarily reprogrammed; the
        pad is reprogrammed normally when you finish or cancel.
        <span v-if="store.deviceConfig?.knobSlots">
          Slots are already measured — run again to re-measure.</span
        >
      </p>
      <button
        @click="start"
        class="px-3 py-1.5 text-xs rounded font-medium bg-[var(--bg-hover)] hover:bg-[var(--border)] transition-colors"
      >
        Find knob slots
      </button>
    </template>

    <template v-else-if="phase === 'probing'">
      <p class="text-xs text-[var(--text-muted)]">
        Keep this window focused and make sure the pad is on
        <strong>layer 1</strong>. Step {{ step + 1 }} of {{ STEPS.length }}:
      </p>
      <div
        class="text-sm font-medium px-3 py-2 rounded bg-[var(--accent)]/15 text-[var(--accent)]"
      >
        {{ STEPS[step].label }}
      </div>
      <div class="flex gap-2">
        <button
          @click="back"
          :disabled="step === 0"
          class="px-3 py-1 text-xs rounded bg-[var(--bg-hover)] disabled:opacity-40"
        >
          Back
        </button>
        <button
          @click="skip"
          class="px-3 py-1 text-xs rounded bg-[var(--bg-hover)]"
        >
          Nothing happens — skip
        </button>
        <button
          @click="cancel"
          class="px-3 py-1 text-xs rounded text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
      </div>
    </template>

    <template v-else>
      <table class="text-xs">
        <tr
          v-for="s in STEPS"
          :key="s.key"
          :class="duplicates.has(s.key) ? 'text-[var(--error)]' : ''"
        >
          <td class="pr-4 py-0.5 text-[var(--text-muted)]">{{ s.label }}</td>
          <td class="font-mono">{{ found[s.key] ?? "—" }}</td>
        </tr>
      </table>
      <p v-if="duplicates.size" class="text-xs text-[var(--error)]">
        Two actions reported the same slot — run the finder again.
      </p>
      <div class="flex gap-2">
        <button
          @click="saveAndProgram"
          :disabled="duplicates.size > 0 || programming"
          class="px-3 py-1.5 text-xs rounded font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          Save &amp; program pad
        </button>
        <button
          @click="start"
          class="px-3 py-1.5 text-xs rounded bg-[var(--bg-hover)]"
        >
          Start over
        </button>
        <button
          @click="cancel"
          class="px-3 py-1.5 text-xs rounded text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
      </div>
    </template>

    <div
      v-if="error"
      class="text-xs px-3 py-2 rounded bg-red-500/10 text-[var(--error)]"
    >
      {{ error }}
    </div>
  </div>
</template>
