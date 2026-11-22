<script setup lang="ts">
import { computed } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import type { Step, SendMode } from "@shared/types";

const props = defineProps<{ step: Step; index: number; total: number }>();
const emit = defineEmits<{
  update: [step: Step];
  remove: [];
  "move-up": [];
  "move-down": [];
}>();

const store = useMacropadStore();

const stepType = computed(() => {
  if ("command" in props.step) return "command";
  if ("keys" in props.step) return "keys";
  if ("prompt" in props.step) return "prompt";
  if ("terminal" in props.step) return "terminal";
  if ("shell" in props.step) return "shell";
  if ("chat" in props.step) return "chat";
  if ("browser" in props.step) return "browser";
  if ("delay" in props.step) return "delay";
  if ("notify" in props.step) return "notify";
  return "unknown";
});

function update(patch: Partial<Step>) {
  emit("update", { ...props.step, ...patch } as Step);
}

const promptOptions = computed(() =>
  [...store.prompts.values()].map((p) => ({ id: p.id, title: p.title })),
);

// Args are typed as JSON when they parse as JSON, otherwise kept as a plain string,
// so `auto` and `"auto"` both mean the string "auto".
const argsText = computed(() => {
  const args = (props.step as { args?: unknown }).args;
  if (args === undefined) return "";
  if (typeof args === "string") {
    try {
      JSON.parse(args);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args);
});

function setArgs(text: string) {
  const trimmed = text.trim();
  let args: unknown = undefined;
  if (trimmed) {
    try {
      args = JSON.parse(trimmed);
    } catch {
      args = trimmed;
    }
  }
  update({ args } as Partial<Step>);
}

const filteredCommands = computed(() => {
  if (!("command" in props.step)) return [];
  const q = (props.step as { command: string }).command.toLowerCase();
  if (!q) return store.commandIds.slice(0, 20);
  return store.commandIds
    .filter((c) => c.toLowerCase().includes(q))
    .slice(0, 15);
});
</script>

<template>
  <div
    class="flex items-start gap-2 p-2 bg-[var(--bg)] rounded border border-[var(--border)] text-xs group"
  >
    <!-- Type badge -->
    <span
      class="shrink-0 mt-0.5 px-1.5 py-0.5 rounded bg-[var(--bg-raised)] text-[var(--text-muted)] text-[10px] font-mono"
    >
      {{ stepType }}
    </span>

    <!-- Fields -->
    <div class="flex-1 space-y-1.5">
      <!-- command -->
      <template v-if="'command' in step">
        <input
          :value="(step as any).command"
          @input="
            update({ command: ($event.target as HTMLInputElement).value })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder="command id"
          list="cmd-list"
        />
        <datalist id="cmd-list">
          <option v-for="c in filteredCommands" :key="c" :value="c" />
        </datalist>
        <input
          :value="argsText"
          @change="setArgs(($event.target as HTMLInputElement).value)"
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs font-mono text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder='args (optional) — plain text, or JSON like {"slug": "auto"}'
        />
        <label
          class="flex items-center gap-1 text-[10px] text-[var(--text-muted)]"
        >
          <input
            type="checkbox"
            :checked="(step as any).optional"
            @change="
              update({ optional: ($event.target as HTMLInputElement).checked })
            "
            class="rounded"
          />
          optional
        </label>
      </template>

      <!-- keys -->
      <template v-else-if="'keys' in step">
        <input
          :value="(step as any).keys"
          @input="update({ keys: ($event.target as HTMLInputElement).value })"
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder="e.g. cmd+shift+l"
        />
      </template>

      <!-- prompt -->
      <template v-else-if="'prompt' in step">
        <select
          :value="(step as any).prompt"
          @change="
            update({ prompt: ($event.target as HTMLSelectElement).value })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)]"
        >
          <option value="" disabled>Select prompt…</option>
          <option v-for="p in promptOptions" :key="p.id" :value="p.id">
            {{ p.title }} ({{ p.id }})
          </option>
        </select>
        <select
          :value="(step as any).mode ?? ''"
          @change="
            update({
              mode:
                (($event.target as HTMLSelectElement).value as SendMode) ||
                undefined,
            })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)]"
        >
          <option value="">use current mode</option>
          <option value="paste">paste</option>
          <option value="paste+send">paste+send</option>
          <option value="newChat+send">newChat+send</option>
        </select>
      </template>

      <!-- terminal -->
      <template v-else-if="'terminal' in step">
        <input
          :value="(step as any).terminal"
          @input="
            update({ terminal: ($event.target as HTMLInputElement).value })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder="command to send to terminal"
        />
        <input
          :value="(step as any).name ?? ''"
          @input="
            update({
              name: ($event.target as HTMLInputElement).value || undefined,
            })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder="terminal name (optional)"
        />
      </template>

      <!-- shell -->
      <template v-else-if="'shell' in step">
        <input
          :value="(step as any).shell"
          @input="update({ shell: ($event.target as HTMLInputElement).value })"
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder="shell command"
        />
      </template>

      <!-- chat -->
      <template v-else-if="'chat' in step">
        <select
          :value="(step as any).chat"
          @change="
            update({
              chat: ($event.target as HTMLSelectElement).value as
                | 'focus'
                | 'newChat'
                | 'send',
            })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)]"
        >
          <option value="focus">focus</option>
          <option value="newChat">newChat</option>
          <option value="send">send</option>
        </select>
      </template>

      <!-- browser -->
      <template v-else-if="'browser' in step">
        <select
          :value="(step as any).browser"
          @change="
            update({
              browser: ($event.target as HTMLSelectElement).value as
                | 'focusOrNew'
                | 'new',
            })
          "
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)]"
        >
          <option value="focusOrNew">focus existing tab, or open new</option>
          <option value="new">always open new tab</option>
        </select>
      </template>

      <!-- delay -->
      <template v-else-if="'delay' in step">
        <div class="flex items-center gap-1">
          <input
            type="number"
            :value="(step as any).delay"
            @input="
              update({
                delay: parseInt(($event.target as HTMLInputElement).value) || 0,
              })
            "
            class="w-20 px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          />
          <span class="text-[var(--text-muted)]">ms</span>
        </div>
      </template>

      <!-- notify -->
      <template v-else-if="'notify' in step">
        <input
          :value="(step as any).notify"
          @input="update({ notify: ($event.target as HTMLInputElement).value })"
          class="w-full px-2 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          placeholder="notification message"
        />
      </template>
    </div>

    <!-- Controls -->
    <div
      class="shrink-0 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
    >
      <button
        v-if="index > 0"
        @click="emit('move-up')"
        class="text-[var(--text-muted)] hover:text-[var(--text)] text-[10px]"
      >
        ▲
      </button>
      <button
        v-if="index < total - 1"
        @click="emit('move-down')"
        class="text-[var(--text-muted)] hover:text-[var(--text)] text-[10px]"
      >
        ▼
      </button>
      <button
        @click="emit('remove')"
        class="text-[var(--error)] hover:text-red-400 text-[10px]"
      >
        ✕
      </button>
    </div>
  </div>
</template>
