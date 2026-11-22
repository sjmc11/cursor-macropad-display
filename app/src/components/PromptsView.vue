<script setup lang="ts">
import { ref, computed } from "vue";
import { useMacropadStore } from "@/stores/macropad";

const store = useMacropadStore();
const selectedId = ref<string | null>(null);
const editBody = ref("");
const newId = ref("");
const showNew = ref(false);

const promptList = computed(() => [...store.prompts.values()].sort((a, b) => a.title.localeCompare(b.title)));

const selectedPrompt = computed(() => {
  if (!selectedId.value) return null;
  return store.prompts.get(selectedId.value) ?? null;
});

function selectPrompt(id: string) {
  selectedId.value = id;
  const p = store.prompts.get(id);
  if (p) {
    editBody.value = p.body.startsWith("# ") ? p.body : `# ${p.title}\n${p.body}`;
    // Reconstruct full file content
    editBody.value = `# ${p.title}\n${p.body}`;
  }
}

async function savePrompt() {
  if (!selectedId.value) return;
  await store.savePrompt(selectedId.value, editBody.value);
}

async function createPrompt() {
  const id = newId.value.trim().replace(/\s+/g, "-").toLowerCase();
  if (!id) return;
  await store.savePrompt(id, `# ${id}\n\nYour prompt here.\n`);
  showNew.value = false;
  newId.value = "";
  selectPrompt(id);
}

async function deletePrompt() {
  if (!selectedId.value) return;
  // Check if any input uses this prompt
  const usedBy = Object.entries(store.config?.inputs ?? {})
    .filter(([, a]) => "steps" in a && a.steps.some((s: any) => "prompt" in s && s.prompt === selectedId.value))
    .map(([id]) => id);

  if (usedBy.length > 0 && !confirm(`This prompt is used by: ${usedBy.join(", ")}. Delete anyway?`)) return;

  await store.removePrompt(selectedId.value);
  selectedId.value = null;
}

const templateVars = ["{{file}}", "{{selection}}", "{{language}}", "{{problems}}", "{{clipboard}}", "{{workspace}}"];
const templateSections = ["{{#selection}}…{{/selection}}", "{{^selection}}…{{/selection}}"];

function insertVar(v: string) {
  editBody.value += v;
}
</script>

<template>
  <div class="flex h-full">
    <!-- Sidebar -->
    <div class="w-56 border-r border-[var(--border)] flex flex-col">
      <div class="p-3 border-b border-[var(--border)] flex justify-between items-center">
        <span class="text-xs font-medium text-[var(--text-muted)]">Prompts ({{ promptList.length }})</span>
        <button @click="showNew = !showNew" class="text-xs text-[var(--accent)] hover:underline">+ New</button>
      </div>
      <!-- New prompt input -->
      <div v-if="showNew" class="p-2 border-b border-[var(--border)]">
        <input v-model="newId" @keyup.enter="createPrompt" class="w-full px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-xs text-[var(--text)]" placeholder="prompt-id" />
        <button @click="createPrompt" class="mt-1 text-xs text-[var(--accent)]">Create</button>
      </div>
      <div class="flex-1 overflow-y-auto">
        <button
          v-for="p in promptList"
          :key="p.id"
          @click="selectPrompt(p.id)"
          class="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-hover)] transition-colors"
          :class="selectedId === p.id ? 'bg-[var(--bg-hover)] text-[var(--text)]' : 'text-[var(--text-muted)]'"
        >
          <div class="font-medium truncate">{{ p.title }}</div>
          <div class="text-[10px] opacity-60">{{ p.id }}.md</div>
        </button>
      </div>
    </div>

    <!-- Editor -->
    <div v-if="selectedPrompt" class="flex-1 flex flex-col">
      <div class="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)]">
        <span class="text-sm font-medium">{{ selectedPrompt.title }}</span>
        <span class="text-xs text-[var(--text-muted)]">{{ selectedId }}.md</span>
        <div class="ml-auto flex gap-2">
          <button @click="deletePrompt" class="text-xs text-[var(--error)] hover:underline">Delete</button>
          <button @click="savePrompt" class="px-3 py-1 text-xs rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]">Save</button>
        </div>
      </div>
      <!-- Template variable buttons -->
      <div class="flex flex-wrap gap-1 px-4 py-2 border-b border-[var(--border)]">
        <button v-for="v in templateVars" :key="v" @click="insertVar(v)"
          class="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] font-mono">
          {{ v }}
        </button>
        <button v-for="s in templateSections" :key="s" @click="insertVar(s)"
          class="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] font-mono">
          {{ s.replace('…', '…') }}
        </button>
      </div>
      <textarea
        v-model="editBody"
        class="flex-1 p-4 bg-[var(--bg)] text-sm text-[var(--text)] font-mono resize-none focus:outline-none"
        spellcheck="false"
      />
    </div>

    <!-- Empty state -->
    <div v-else class="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
      Select a prompt to edit
    </div>
  </div>
</template>
