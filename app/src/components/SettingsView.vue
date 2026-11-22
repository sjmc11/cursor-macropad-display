<script setup lang="ts">
import { useMacropadStore } from "@/stores/macropad";

const store = useMacropadStore();

async function updateDefault(key: string, value: unknown) {
  await store.editConfig(["defaults", key], value);
}

async function updateBridge(key: string, value: unknown) {
  await store.editConfig(["bridge", key], value);
}

async function updateChatSteps(action: string, raw: string) {
  try {
    const steps = JSON.parse(raw);
    await store.editConfig(["chat", action], steps);
  } catch {
    // ignore parse errors while typing
  }
}
</script>

<template>
  <div class="p-6 max-w-lg space-y-6">
    <h2 class="text-sm font-semibold text-[var(--text)]">Settings</h2>

    <!-- Defaults -->
    <section class="space-y-3">
      <h3 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Defaults</h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">Send mode</label>
          <select
            :value="store.config?.defaults?.sendMode ?? 'paste+send'"
            @change="updateDefault('sendMode', ($event.target as HTMLSelectElement).value)"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
          >
            <option value="paste">paste</option>
            <option value="paste+send">paste+send</option>
            <option value="newChat+send">newChat+send</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">After keys delay (ms)</label>
          <input type="number"
            :value="store.config?.defaults?.afterKeysDelayMs ?? 60"
            @change="updateDefault('afterKeysDelayMs', parseInt(($event.target as HTMLInputElement).value))"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
          />
        </div>
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">Before send delay (ms)</label>
          <input type="number"
            :value="store.config?.defaults?.beforeSendDelayMs ?? 120"
            @change="updateDefault('beforeSendDelayMs', parseInt(($event.target as HTMLInputElement).value))"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
          />
        </div>
      </div>
    </section>

    <!-- Bridge -->
    <section class="space-y-3">
      <h3 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Hammerspoon bridge</h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">Port</label>
          <input type="number"
            :value="store.config?.bridge?.port ?? 47615"
            @change="updateBridge('port', parseInt(($event.target as HTMLInputElement).value))"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
          />
        </div>
        <div>
          <label class="block text-xs text-[var(--text-muted)] mb-1">Token file</label>
          <input
            :value="store.config?.bridge?.tokenFile ?? '~/.macropad/token'"
            @change="updateBridge('tokenFile', ($event.target as HTMLInputElement).value)"
            class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-sm text-[var(--text)]"
          />
        </div>
      </div>
    </section>

    <!-- Chat key sequences -->
    <section class="space-y-3">
      <h3 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Chat key sequences</h3>
      <p class="text-xs text-[var(--text-muted)]">JSON arrays of steps that the extension uses to interact with Cursor's chat. Edit as JSON.</p>
      <div v-for="action in ['focus', 'newChat', 'send']" :key="action">
        <label class="block text-xs text-[var(--text-muted)] mb-1">{{ action }}</label>
        <textarea
          :value="JSON.stringify((store.config?.chat as any)?.[action] ?? [], null, 2)"
          @change="updateChatSteps(action, ($event.target as HTMLTextAreaElement).value)"
          rows="3"
          class="w-full px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-xs text-[var(--text)] font-mono resize-none"
          spellcheck="false"
        />
      </div>
    </section>

    <!-- Validation results -->
    <section v-if="store.errors.length" class="space-y-2">
      <h3 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Validation</h3>
      <div v-for="e in store.errors" :key="e.path + e.message"
        class="text-xs px-2 py-1 rounded"
        :class="e.level === 'error' ? 'bg-red-500/10 text-[var(--error)]' : 'bg-yellow-500/10 text-[var(--warning)]'"
      >
        <span class="font-mono">{{ e.path }}</span>: {{ e.message }}
      </div>
    </section>
  </div>
</template>
