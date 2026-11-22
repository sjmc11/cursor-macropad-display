<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import type { Action, Step } from "@shared/types";
import StepEditor from "./StepEditor.vue";

const props = withDefaults(
  defineProps<{ inputId: string; variant?: "modal" | "panel" }>(),
  { variant: "modal" },
);
const emit = defineEmits<{ close: [] }>();

const store = useMacropadStore();

const action = computed<Action | undefined>(
  () => store.config?.inputs?.[props.inputId] as Action | undefined,
);

const PAD_PRESETS = ["Volume−", "Volume+", "Mute"] as const;

type ActionType = "steps" | "cycle" | "pad";
const actionType = ref<ActionType>("steps");
const label = ref("");
const steps = ref<Step[]>([]);
const cycleName = ref("");
const cycleOp = ref<"next" | "prev" | "select">("next");
const padLabel = ref<string>(PAD_PRESETS[0]);

onMounted(loadFromConfig);
watch(() => props.inputId, loadFromConfig);

function loadFromConfig() {
  const appOnly = store.deviceConfig?.appOnly?.[props.inputId];
  if (appOnly) {
    actionType.value = "pad";
    padLabel.value = appOnly;
    label.value = appOnly;
    return;
  }
  const a = action.value;
  if (!a) {
    actionType.value = "steps";
    label.value = "";
    steps.value = [];
    return;
  }
  label.value = a.label;
  if ("steps" in a) {
    actionType.value = "steps";
    steps.value = JSON.parse(JSON.stringify(a.steps));
  } else {
    actionType.value = "cycle";
    cycleName.value = a.cycle;
    cycleOp.value = a.do;
  }
}

function setType(type: ActionType) {
  actionType.value = type;
  if (type === "pad" && !padLabel.value) padLabel.value = PAD_PRESETS[0];
  if (type === "pad") label.value = padLabel.value;
}

function addStep(type: string) {
  const templates: Record<string, Step> = {
    command: { command: "" },
    keys: { keys: "" },
    prompt: { prompt: "" },
    terminal: { terminal: "", name: "" },
    shell: { shell: "" },
    chat: { chat: "focus" },
    browser: { browser: "focusOrNew" },
    delay: { delay: 150 },
    notify: { notify: "" },
  };
  steps.value.push(
    JSON.parse(JSON.stringify(templates[type] ?? templates.command)),
  );
}

function removeStep(i: number) {
  steps.value.splice(i, 1);
}

function moveStep(from: number, dir: -1 | 1) {
  const to = from + dir;
  if (to < 0 || to >= steps.value.length) return;
  const tmp = steps.value[from];
  steps.value[from] = steps.value[to];
  steps.value[to] = tmp;
}

const cycleNames = computed(() => Object.keys(store.config?.cycles ?? {}));

async function clearAppOnly() {
  if (!store.deviceConfig?.appOnly?.[props.inputId]) return;
  await store.editDeviceConfig(["appOnly", props.inputId], undefined);
}

async function save() {
  if (actionType.value === "pad") {
    const media = padLabel.value.trim() || PAD_PRESETS[0];
    // Pad media lives in device.jsonc; drop any Cursor binding for this input.
    if (action.value)
      await store.editConfig(["inputs", props.inputId], undefined);
    await store.editDeviceConfig(["appOnly", props.inputId], media);
    emit("close");
    return;
  }

  await clearAppOnly();
  let value: Action;
  if (actionType.value === "cycle") {
    value = { label: label.value, cycle: cycleName.value, do: cycleOp.value };
  } else {
    value = { label: label.value, steps: steps.value };
  }
  await store.editConfig(["inputs", props.inputId], value);
  emit("close");
}

async function remove() {
  await clearAppOnly();
  await store.editConfig(["inputs", props.inputId], undefined);
  emit("close");
}

const defaultAction = computed(() => store.defaultInputs?.[props.inputId]);
const isDefault = computed(() => {
  if (store.deviceConfig?.appOnly?.[props.inputId]) return false;
  return store.isDefaultInput(props.inputId);
});

async function resetToDefault() {
  await clearAppOnly();
  await store.resetInput(props.inputId);
  emit("close");
}

const errors = computed(() =>
  store.errors.filter(
    (e) =>
      e.path === `inputs.${props.inputId}` ||
      e.path.startsWith(`inputs.${props.inputId}[`),
  ),
);
</script>

<template>
  <div
    :class="
      variant === 'panel'
        ? 'h-full flex flex-col'
        : 'fixed inset-0 bg-black/50 flex items-center justify-center z-50'
    "
    @click.self="variant !== 'panel' && emit('close')"
  >
    <div
      :class="
        variant === 'panel'
          ? 'flex-1 flex flex-col overflow-hidden'
          : 'bg-[var(--bg-raised)] border border-[var(--border)] rounded-xl w-[560px] max-h-[80vh] flex flex-col shadow-xl'
      "
    >
      <div
        class="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]"
      >
        <div>
          <span class="font-medium text-sm">{{ inputId }}</span>
          <span
            v-if="actionType === 'pad'"
            class="ml-2 text-xs text-[var(--warning)]"
            >Handled by pad</span
          >
        </div>
        <button
          @click="emit('close')"
          class="text-[var(--text-muted)] hover:text-[var(--text)] text-lg"
        >
          ×
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1"
            >Type</label
          >
          <div class="flex gap-2">
            <button
              v-for="t in [
                { id: 'steps' as const, label: 'Steps' },
                { id: 'cycle' as const, label: 'Cycle' },
                { id: 'pad' as const, label: 'Pad media' },
              ]"
              :key="t.id"
              @click="setType(t.id)"
              class="px-3 py-1 rounded text-xs"
              :class="
                actionType === t.id
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg)] text-[var(--text-muted)] border border-[var(--border)]'
              "
            >
              {{ t.label }}
            </button>
          </div>
        </div>

        <template v-if="actionType === 'pad'">
          <div class="text-sm text-[var(--text-muted)]">
            The pad sends a system media key directly (no Cursor extension).
            After saving, click <strong>Program pad</strong> to write it to the
            hardware.
          </div>
          <div>
            <label class="block text-xs text-[var(--text-muted)] mb-1"
              >Media action</label
            >
            <div class="flex flex-wrap gap-2 mb-2">
              <button
                v-for="p in PAD_PRESETS"
                :key="p"
                @click="padLabel = p"
                class="px-3 py-1 rounded text-xs"
                :class="
                  padLabel === p
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg)] text-[var(--text-muted)] border border-[var(--border)]'
                "
              >
                {{ p }}
              </button>
            </div>
            <input
              v-model="padLabel"
              class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
              placeholder="Volume−, Volume+, or Mute"
            />
            <p class="mt-1 text-[10px] text-[var(--text-muted)]">
              Label must include Volume−, Volume+, or Mute so Program pad can
              map it.
            </p>
          </div>
        </template>

        <template v-else>
          <div>
            <label class="block text-xs text-[var(--text-muted)] mb-1"
              >Label</label
            >
            <input
              v-model="label"
              class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          <template v-if="actionType === 'steps'">
            <div class="space-y-2">
              <StepEditor
                v-for="(step, i) in steps"
                :key="i"
                :step="step"
                :index="i"
                :total="steps.length"
                @update="steps[i] = $event"
                @remove="removeStep(i)"
                @move-up="moveStep(i, -1)"
                @move-down="moveStep(i, 1)"
              />
            </div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="type in [
                  'command',
                  'keys',
                  'prompt',
                  'terminal',
                  'shell',
                  'chat',
                  'browser',
                  'delay',
                  'notify',
                ]"
                :key="type"
                @click="addStep(type)"
                class="px-2 py-1 text-[10px] rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-muted)]"
              >
                + {{ type }}
              </button>
            </div>
          </template>

          <template v-if="actionType === 'cycle'">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-[var(--text-muted)] mb-1"
                  >Cycle</label
                >
                <select
                  v-model="cycleName"
                  class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
                >
                  <option v-for="n in cycleNames" :key="n" :value="n">
                    {{ n }}
                  </option>
                </select>
              </div>
              <div>
                <label class="block text-xs text-[var(--text-muted)] mb-1"
                  >Operation</label
                >
                <select
                  v-model="cycleOp"
                  class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
                >
                  <option value="next">next</option>
                  <option value="prev">prev</option>
                  <option value="select">select</option>
                </select>
              </div>
            </div>
          </template>
        </template>

        <div v-if="errors.length" class="space-y-1">
          <div
            v-for="e in errors"
            :key="e.path + e.message"
            class="text-xs px-2 py-1 rounded"
            :class="
              e.level === 'error'
                ? 'bg-red-500/10 text-[var(--error)]'
                : 'bg-yellow-500/10 text-[var(--warning)]'
            "
          >
            {{ e.message }}
          </div>
        </div>
      </div>

      <div
        class="flex justify-between px-5 py-3 border-t border-[var(--border)]"
      >
        <div class="flex items-center gap-4">
          <button
            v-if="action || store.deviceConfig?.appOnly?.[inputId]"
            @click="remove"
            class="text-xs text-[var(--error)] hover:underline"
          >
            Remove binding
          </button>
          <button
            v-if="store.defaultInputs"
            @click="resetToDefault"
            :disabled="isDefault"
            :title="
              isDefault
                ? 'Already the default'
                : defaultAction
                  ? `Restore “${defaultAction.label}”`
                  : 'Default is unbound'
            "
            class="text-xs text-[var(--text-muted)] enabled:hover:text-[var(--text)] enabled:hover:underline disabled:opacity-40"
          >
            Reset to default
          </button>
        </div>
        <div class="flex gap-2">
          <button
            @click="emit('close')"
            class="px-3 py-1.5 text-xs rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <button
            @click="save"
            class="px-4 py-1.5 text-xs rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
