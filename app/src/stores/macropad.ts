import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  getProjectRoot, readFile, writeFile, listFiles, deleteFile, onFileChanged,
  deviceDetect, deviceSetLighting, devicePlayFrames,
  onDeviceConnected, onDeviceDisconnected,
} from "@/api";
import { parseJsonc } from "@shared/jsonc";
import { allInputs, keys, knobs, knobInputs } from "@shared/scheme";
import { validate, type ValidationResult } from "@shared/validate";
import { generateKeybindings, generateMappingDoc } from "@shared/generate";
import type {
  Config,
  DeviceConfig,
  Prompt,
  Action,
  Orientation,
  StartupPreset,
} from "@shared/types";
import { buildAllLighting, generateStartupFrames } from "@shared/lighting";
import { modify, applyEdits } from "jsonc-parser";

export const useMacropadStore = defineStore("macropad", () => {
  const projectRoot = ref("");
  const configRaw = ref("");
  const deviceConfigRaw = ref("");
  const config = ref<Config | null>(null);
  const defaultInputs = ref<Record<string, Action> | null>(null);
  const deviceConfig = ref<DeviceConfig | null>(null);
  const prompts = ref<Map<string, Prompt>>(new Map());
  const errors = ref<ValidationResult[]>([]);
  const lastInput = ref<{ id: string; label: string; at: number } | null>(null);
  const commandIds = ref<string[]>([]);
  const loading = ref(true);

  const inputs = computed(() => {
    if (!deviceConfig.value) return [];
    return allInputs(deviceConfig.value);
  });

  const orientation = computed<Orientation>(() => deviceConfig.value?.orientation ?? 0);

  async function load() {
    loading.value = true;
    try {
      projectRoot.value = await getProjectRoot();
      await Promise.all([loadConfig(), loadDefaults(), loadDeviceConfig(), loadPrompts(), loadLastInput(), loadCommands()]);
      runValidation();
    } finally {
      loading.value = false;
    }
  }

  async function loadConfig() {
    const path = `${projectRoot.value}/config/macropad.jsonc`;
    configRaw.value = await readFile(path);
    config.value = parseJsonc<Config>(configRaw.value);
  }

  async function loadDefaults() {
    try {
      const raw = await readFile(`${projectRoot.value}/config/macropad.defaults.jsonc`);
      defaultInputs.value = parseJsonc<Config>(raw).inputs ?? {};
    } catch {
      defaultInputs.value = null;
    }
  }

  async function loadDeviceConfig() {
    const path = `${projectRoot.value}/config/device.jsonc`;
    deviceConfigRaw.value = await readFile(path);
    deviceConfig.value = parseJsonc<DeviceConfig>(deviceConfigRaw.value);
  }

  async function loadPrompts() {
    const dir = `${projectRoot.value}/prompts`;
    const files = await listFiles(dir, ".md");
    const map = new Map<string, Prompt>();
    for (const name of files) {
      const id = name.replace(/\.md$/, "");
      const text = await readFile(`${dir}/${name}`);
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      let title = id;
      if (lines[0]?.startsWith("# ")) {
        title = lines[0].slice(2).trim();
        lines.shift();
      }
      map.set(id, { id, title, body: lines.join("\n").trim() });
    }
    prompts.value = map;
  }

  async function loadLastInput() {
    try {
      const text = await readFile("~/.macropad/last-input.json");
      lastInput.value = JSON.parse(text);
    } catch {
      lastInput.value = null;
    }
  }

  async function loadCommands() {
    try {
      const text = await readFile("~/.macropad/commands.json");
      commandIds.value = JSON.parse(text);
    } catch {
      commandIds.value = [];
    }
  }

  /** Mark an input as just pressed, e.g. when the pad's chord reaches the Studio window. */
  function markInput(id: string) {
    const label = (config.value?.inputs?.[id] as Action | undefined)?.label ?? id;
    lastInput.value = { id, label, at: Date.now() };
  }

  function runValidation() {
    if (!config.value || !deviceConfig.value) {
      errors.value = [];
      return;
    }
    const promptIds = new Set(prompts.value.keys());
    errors.value = validate(config.value, deviceConfig.value, promptIds);
  }

  // ---- Mutations ----

  async function saveConfig(raw: string) {
    configRaw.value = raw;
    config.value = parseJsonc<Config>(raw);
    await writeFile(`${projectRoot.value}/config/macropad.jsonc`, raw, true);
    runValidation();
  }

  /** Edit a single JSON path in macropad.jsonc, preserving comments. */
  async function editConfig(jsonPath: (string | number)[], value: unknown) {
    const edits = modify(configRaw.value, jsonPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } });
    const updated = applyEdits(configRaw.value, edits);
    await saveConfig(updated);
  }

  function isDefaultInput(inputId: string): boolean {
    return sameJson(config.value?.inputs?.[inputId], defaultInputs.value?.[inputId]);
  }

  /** Restore one binding from macropad.defaults.jsonc; unbinds it if it has no default. */
  async function resetInput(inputId: string) {
    if (!defaultInputs.value) return;
    await editConfig(["inputs", inputId], defaultInputs.value[inputId]);
  }

  async function saveDeviceConfig(raw: string) {
    deviceConfigRaw.value = raw;
    deviceConfig.value = parseJsonc<DeviceConfig>(raw);
    await writeFile(`${projectRoot.value}/config/device.jsonc`, raw, true);
    runValidation();
  }

  async function editDeviceConfig(jsonPath: (string | number)[], value: unknown) {
    const edits = modify(deviceConfigRaw.value, jsonPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } });
    const updated = applyEdits(deviceConfigRaw.value, edits);
    await saveDeviceConfig(updated);
  }

  async function savePrompt(id: string, body: string) {
    await writeFile(`${projectRoot.value}/prompts/${id}.md`, body);
    await loadPrompts();
    runValidation();
  }

  async function removePrompt(id: string) {
    await deleteFile(`${projectRoot.value}/prompts/${id}.md`);
    await loadPrompts();
    runValidation();
  }

  function getKeybindings() {
    if (!deviceConfig.value) return [];
    return generateKeybindings(deviceConfig.value);
  }

  function getMappingDoc() {
    if (!deviceConfig.value || !config.value) return "";
    return generateMappingDoc(deviceConfig.value, config.value);
  }

  // ---- Startup sequence ----

  const deviceConnected = ref(false);

  async function playStartupSequence() {
    if (!deviceConfig.value) return;
    const startup = deviceConfig.value.lighting?.startup;
    if (!startup?.enabled) return;

    try {
      const frames = generateStartupFrames(
        deviceConfig.value,
        startup.preset as StartupPreset,
        startup.durationMs,
        startup.fps,
      );
      const restore = buildAllLighting(deviceConfig.value);
      const frameMs = Math.round(1000 / startup.fps);
      await devicePlayFrames(
        JSON.stringify(frames),
        frameMs,
        JSON.stringify(restore),
      );
    } catch {
      // Best effort — device might not be connected
    }
  }

  async function checkDeviceAndStartup() {
    try {
      const info = await deviceDetect();
      const wasConnected = deviceConnected.value;
      deviceConnected.value = info.connected;
      if (info.connected && !wasConnected) {
        await playStartupSequence();
      }
    } catch {
      deviceConnected.value = false;
    }
  }

  // File watcher integration
  function setupWatcher() {
    onFileChanged(async (payload) => {
      const p = payload.path;
      if (p.endsWith("macropad.defaults.jsonc")) await loadDefaults();
      else if (p.endsWith("macropad.jsonc")) await loadConfig().then(runValidation);
      else if (p.endsWith("device.jsonc")) await loadDeviceConfig().then(runValidation);
      else if (p.includes("/prompts/") && p.endsWith(".md")) await loadPrompts().then(runValidation);
      else if (p.endsWith("last-input.json")) await loadLastInput();
      else if (p.endsWith("commands.json")) await loadCommands();
    });

    // Device hot-plug events
    onDeviceConnected(async () => {
      deviceConnected.value = true;
      await playStartupSequence();
    });
    onDeviceDisconnected(() => {
      deviceConnected.value = false;
    });

    // Initial device check
    checkDeviceAndStartup();
  }

  return {
    projectRoot, config, defaultInputs, deviceConfig, configRaw, deviceConfigRaw,
    prompts, errors, lastInput, commandIds, loading, deviceConnected,
    inputs, orientation, keys, knobs, knobInputs,
    load, setupWatcher, runValidation, markInput,
    saveConfig, editConfig, isDefaultInput, resetInput, saveDeviceConfig, editDeviceConfig,
    savePrompt, removePrompt, getKeybindings, getMappingDoc,
    playStartupSequence,
  };
});

/** Deep equality for parsed JSON, ignoring object key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
