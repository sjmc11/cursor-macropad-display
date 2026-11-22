import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJsonc } from '../../shared/jsonc';

// Re-export shared types so existing imports from './config' keep working.
export type { SendMode, Step, Action, CycleDef, Config, Prompt } from '../../shared/types';
export { SEND_MODES } from '../../shared/types';

import type { Config, Prompt } from '../../shared/types';

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(configPath: string): Config {
  const file = expandHome(configPath);
  const raw = parseJsonc<Partial<Config>>(fs.readFileSync(file, 'utf8'));
  const cfg: Config = {
    bridge: { port: 47615, tokenFile: '~/.macropad/token', ...raw.bridge },
    defaults: { sendMode: 'paste+send', afterKeysDelayMs: 60, beforeSendDelayMs: 120, ...raw.defaults },
    chat: { focus: [], newChat: [], send: [], ...raw.chat },
    promptsDir: path.resolve(path.dirname(file), expandHome(raw.promptsDir ?? '../prompts')),
    cycles: raw.cycles ?? {},
    inputs: raw.inputs ?? {},
  };
  return cfg;
}

export function loadPrompts(dir: string): Map<string, Prompt> {
  const prompts = new Map<string, Prompt>();
  if (!fs.existsSync(dir)) return prompts;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const id = name.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    let title = id;
    if (lines[0]?.startsWith('# ')) {
      title = lines[0].slice(2).trim();
      lines.shift();
    }
    prompts.set(id, { id, title, body: lines.join('\n').trim() });
  }
  return prompts;
}

/** Fingerprint of config + prompt files, so we can hot-reload cheaply on each input. */
export function fingerprint(configPath: string, promptsDir: string): string {
  const parts: string[] = [];
  const stat = (p: string) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  parts.push(String(stat(expandHome(configPath))));
  if (fs.existsSync(promptsDir)) {
    for (const n of fs.readdirSync(promptsDir).sort()) parts.push(n + stat(path.join(promptsDir, n)));
  }
  return parts.join('|');
}
