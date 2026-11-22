<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useMacropadStore } from "@/stores/macropad";
import {
  readFile,
  readCursorKeybindings,
  writeCursorKeybindings,
  checkBridge,
  checkExtensionInstalled,
} from "@/api";
import { parseJsonc } from "@shared/jsonc";

const store = useMacropadStore();

interface Check {
  label: string;
  status: "ok" | "warn" | "error" | "checking";
  detail: string;
}

const checks = ref<Check[]>([
  { label: "Extension", status: "checking", detail: "" },
  { label: "Keybindings", status: "checking", detail: "" },
  { label: "Hammerspoon bridge", status: "checking", detail: "" },
  { label: "Config path", status: "checking", detail: "" },
]);

const syncing = ref(false);

onMounted(runChecks);

async function runChecks() {
  checks.value = checks.value.map((c) => ({
    ...c,
    status: "checking" as const,
    detail: "",
  }));
  await Promise.all([
    checkExtension(),
    checkKeybindings(),
    checkBridgeStatus(),
    checkConfigPath(),
  ]);
}

async function checkExtension() {
  try {
    const installed = await checkExtensionInstalled();
    // Also check if the extension is actively running (recent last-input.json)
    let active = false;
    try {
      const text = await readFile("~/.macropad/last-input.json");
      const data = JSON.parse(text);
      const ageMs = Date.now() - (data.at ?? 0);
      active = ageMs < 24 * 60 * 60 * 1000; // active if used in last 24h
    } catch {
      /* no last-input */
    }

    if (active) {
      checks.value[0] = {
        label: "Extension",
        status: "ok",
        detail: `${installed} — active`,
      };
    } else {
      checks.value[0] = {
        label: "Extension",
        status: "ok",
        detail: `${installed} installed`,
      };
    }
  } catch {
    // Not installed — check if vsix exists for a helpful message
    let vsixFound = false;
    try {
      const files = await readFile(`${store.projectRoot}/dist`).catch(() => "");
      // readFile on a dir will fail, use list_files instead
    } catch {
      /* ignore */
    }

    try {
      const { listFiles } = await import("@/api");
      const distFiles = await listFiles(`${store.projectRoot}/dist`, ".vsix");
      vsixFound = distFiles.length > 0;
    } catch {
      /* ignore */
    }

    if (vsixFound) {
      checks.value[0] = {
        label: "Extension",
        status: "warn",
        detail:
          "VSIX found in dist/ but not installed. Install via Command Palette → Extensions: Install from VSIX…",
      };
    } else {
      checks.value[0] = {
        label: "Extension",
        status: "warn",
        detail:
          "Not installed. Run: cd extension && npm run package, then install the .vsix",
      };
    }
  }
}

async function checkKeybindings() {
  try {
    const cursorJson = await readCursorKeybindings();
    const cursorBindings = JSON.parse(cursorJson);
    const macropadBindings = cursorBindings.filter(
      (b: any) => b.command === "macropad.input",
    );
    const expected = store.getKeybindings();

    if (macropadBindings.length === 0) {
      checks.value[1] = {
        label: "Keybindings",
        status: "error",
        detail: `No macropad bindings in Cursor. Expected ${expected.length}.`,
      };
    } else if (macropadBindings.length !== expected.length) {
      checks.value[1] = {
        label: "Keybindings",
        status: "warn",
        detail: `${macropadBindings.length} macropad bindings, expected ${expected.length}. Click Sync.`,
      };
    } else {
      checks.value[1] = {
        label: "Keybindings",
        status: "ok",
        detail: `${macropadBindings.length} macropad keybindings in sync`,
      };
    }
  } catch {
    checks.value[1] = {
      label: "Keybindings",
      status: "error",
      detail: "Could not read Cursor keybindings.json",
    };
  }
}

async function checkBridgeStatus() {
  try {
    const tokenFile = store.config?.bridge?.tokenFile ?? "~/.macropad/token";
    const token = (await readFile(tokenFile)).trim();
    const port = store.config?.bridge?.port ?? 47615;
    const result = await checkBridge(port, token);
    checks.value[2] = {
      label: "Hammerspoon bridge",
      status: "ok",
      detail: `Responding on port ${port}`,
    };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("connect")) {
      checks.value[2] = {
        label: "Hammerspoon bridge",
        status: "error",
        detail: "Not reachable. Is Hammerspoon running?",
      };
    } else {
      checks.value[2] = {
        label: "Hammerspoon bridge",
        status: "error",
        detail: msg,
      };
    }
  }
}

async function checkConfigPath() {
  try {
    const settingsRaw = await readFile(
      "~/Library/Application Support/Cursor/User/settings.json",
    );
    // Cursor's settings.json is JSONC (trailing commas, comments)
    const settings = parseJsonc<Record<string, unknown>>(settingsRaw);
    if (!settings) {
      checks.value[3] = {
        label: "Config path",
        status: "warn",
        detail: "Could not parse Cursor settings",
      };
      return;
    }
    const cfgPath = settings["macropad.configPath"] as string | undefined;
    if (cfgPath && cfgPath.includes("macro-controller")) {
      checks.value[3] = { label: "Config path", status: "ok", detail: cfgPath };
    } else if (!cfgPath) {
      checks.value[3] = {
        label: "Config path",
        status: "ok",
        detail: "Using default path (macropad.configPath not set)",
      };
    } else {
      checks.value[3] = {
        label: "Config path",
        status: "warn",
        detail: `Points to: ${cfgPath}`,
      };
    }
  } catch {
    checks.value[3] = {
      label: "Config path",
      status: "warn",
      detail: "Could not read Cursor settings",
    };
  }
}

async function syncKeybindings() {
  syncing.value = true;
  try {
    const cursorJson = await readCursorKeybindings();
    const cursorBindings: any[] = JSON.parse(cursorJson);
    const filtered = cursorBindings.filter(
      (b: any) => b.command !== "macropad.input",
    );
    const newBindings = store.getKeybindings();
    const merged = [...filtered, ...newBindings];
    await writeCursorKeybindings(JSON.stringify(merged, null, 2) + "\n");
    await checkKeybindings();
  } catch (err) {
    checks.value[1] = {
      label: "Keybindings",
      status: "error",
      detail: `Sync failed: ${err}`,
    };
  } finally {
    syncing.value = false;
  }
}

const statusIcons: Record<string, string> = {
  ok: "✓",
  warn: "⚠",
  error: "✕",
  checking: "…",
};
const statusColors: Record<string, string> = {
  ok: "text-[var(--success)]",
  warn: "text-[var(--warning)]",
  error: "text-[var(--error)]",
  checking: "text-[var(--text-muted)]",
};
</script>

<template>
  <div class="p-6 max-w-lg space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold">Cursor Integration</h2>
      <button
        @click="runChecks"
        class="text-xs text-[var(--accent)] hover:underline"
      >
        Re-check
      </button>
    </div>

    <div class="space-y-3">
      <div
        v-for="(check, i) in checks"
        :key="check.label"
        class="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)]"
      >
        <span :class="statusColors[check.status]" class="text-sm mt-0.5">{{
          statusIcons[check.status]
        }}</span>
        <div class="flex-1">
          <div class="text-sm font-medium">{{ check.label }}</div>
          <div class="text-xs text-[var(--text-muted)] mt-0.5">
            {{ check.detail }}
          </div>
        </div>
        <button
          v-if="i === 1 && check.status !== 'ok'"
          @click="syncKeybindings"
          :disabled="syncing"
          class="px-3 py-1 text-xs rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {{ syncing ? "Syncing…" : "Sync" }}
        </button>
      </div>
    </div>
  </div>
</template>
