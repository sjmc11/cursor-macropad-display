import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function getProjectRoot(): Promise<string> {
  return invoke<string>("get_project_root");
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string, backup = false): Promise<void> {
  return invoke("write_file", { path, content, backup });
}

export async function listFiles(dir: string, ext: string): Promise<string[]> {
  return invoke<string[]>("list_files", { dir, ext });
}

export async function deleteFile(path: string): Promise<void> {
  return invoke("delete_file", { path });
}

export async function readCursorKeybindings(): Promise<string> {
  return invoke<string>("read_cursor_keybindings");
}

export async function writeCursorKeybindings(content: string): Promise<void> {
  return invoke("write_cursor_keybindings", { content });
}

export interface FileChanged {
  path: string;
  kind: string;
}

export function onFileChanged(cb: (payload: FileChanged) => void): Promise<UnlistenFn> {
  return listen<FileChanged>("file-changed", (event) => cb(event.payload));
}

// ---- Cursor integration checks ----

export async function checkBridge(port: number, token: string): Promise<string> {
  return invoke<string>("check_bridge", { port, token });
}

export async function checkExtensionInstalled(): Promise<string> {
  return invoke<string>("check_extension_installed");
}

// ---- Device / Lighting ----

export async function deviceDetect(): Promise<{
  vendor_id: number;
  product_id: number;
  product_name: string;
  serial: string;
  connected: boolean;
}> {
  return invoke("device_detect");
}

export async function deviceSetLighting(layersJson: string): Promise<number> {
  return invoke<number>("device_set_lighting", { layersJson });
}

export async function devicePlayFrames(
  framesJson: string,
  frameMs: number,
  restoreJson: string,
): Promise<void> {
  return invoke("device_play_frames", { framesJson, frameMs, restoreJson });
}

export function onDeviceConnected(cb: () => void): Promise<UnlistenFn> {
  return listen("device-connected", () => cb());
}

export function onDeviceDisconnected(cb: () => void): Promise<UnlistenFn> {
  return listen("device-disconnected", () => cb());
}

export function onLightingSequenceFinished(
  cb: (payload: { ok: boolean; error?: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ ok: boolean; error?: string }>("lighting-sequence-finished", (e) => cb(e.payload));
}
