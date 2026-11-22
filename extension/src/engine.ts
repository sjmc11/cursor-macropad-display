import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Action, Config, CycleDef, Prompt, SEND_MODES, SendMode, Step, fingerprint, loadConfig, loadPrompts } from './config';
import { sendKeys } from './bridge';
import { render, TemplateVars } from './template';
import { CursorModelChoice, cycleCurrentModelEffort, loadCursorPreferredModels } from './cursorModels';
import { postToDisplayBridge } from './displayBridge';

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const macropadDir = path.join(os.homedir(), '.macropad');

interface CycleItem { label: string; select: () => Promise<void>; onFocus?: () => void }

export class Engine {
  private cfg!: Config;
  private prompts = new Map<string, Prompt>();
  private fp = '';
  private sendMode: SendMode = 'paste+send';
  private cycleIndex = new Map<string, number>();
  private branchCache?: { at: number; items: string[] };
  private modelsCache?: { at: number; items: CursorModelChoice[] };
  private lastEffort?: { modelId: string; paramId: string; value: string; at: number };
  private queue: Promise<void> = Promise.resolve();
  private status: vscode.StatusBarItem;

  constructor(private out: vscode.OutputChannel) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'macropad.openConfig';
    this.status.show();
  }

  dispose() { this.status.dispose(); }

  get configPath(): string {
    return vscode.workspace.getConfiguration('macropad').get<string>('configPath')!;
  }

  get config(): Config { this.ensureLoaded(); return this.cfg; }
  get promptList(): Prompt[] { this.ensureLoaded(); return [...this.prompts.values()]; }

  /** Loads config/prompts if files changed since last load. */
  ensureLoaded(force = false) {
    const promptsDir = this.cfg?.promptsDir ?? '';
    const fp = fingerprint(this.configPath, promptsDir);
    if (!force && this.cfg && fp === this.fp) return;
    const firstLoad = !this.cfg;
    this.cfg = loadConfig(this.configPath);
    this.prompts = loadPrompts(this.cfg.promptsDir);
    this.fp = fingerprint(this.configPath, this.cfg.promptsDir);
    if (firstLoad) this.sendMode = this.cfg.defaults.sendMode;
    this.out.appendLine(`Loaded ${Object.keys(this.cfg.inputs).length} inputs, ${this.prompts.size} prompts from ${this.configPath}`);
    this.idleStatus();
  }

  /** Serialises work so fast knob spins don't interleave keystrokes. */
  enqueue(label: string, fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.out.appendLine(`[${label}] ${msg}`);
      vscode.window.showErrorMessage(`Macropad – ${label}: ${msg}`);
    });
    return this.queue;
  }

  triggerInput(id: string) {
    this.enqueue(id, async () => {
      this.ensureLoaded();
      const action = this.cfg.inputs[id];
      if (!action) { this.flash(`${id}: unassigned`); return; }
      this.out.appendLine(`→ ${id} (${action.label})`);
      this.writeLastInput(id, action.label);
      await this.runAction(action);
    });
  }

  /** Write ~/.macropad/last-input.json so the Studio app can highlight the pressed key. */
  private writeLastInput(id: string, label: string) {
    try {
      fs.mkdirSync(macropadDir, { recursive: true });
      fs.writeFileSync(path.join(macropadDir, 'last-input.json'), JSON.stringify({ id, label, at: Date.now() }));
    } catch { /* best effort */ }
  }

  /** Write ~/.macropad/commands.json with all known command ids for autocomplete. */
  async exportCommands() {
    const all = await vscode.commands.getCommands(true);
    all.sort();
    try {
      fs.mkdirSync(macropadDir, { recursive: true });
      fs.writeFileSync(path.join(macropadDir, 'commands.json'), JSON.stringify(all));
      this.out.appendLine(`Exported ${all.length} command ids to ~/.macropad/commands.json`);
    } catch (err) {
      this.out.appendLine(`Failed to export commands: ${String(err)}`);
    }
  }

  async runAction(action: Action) {
    if ('steps' in action) {
      const vars = await this.gatherVars();
      await this.runSteps(action.steps, vars);
      return;
    }
    await this.cycle(action.cycle, action.do);
  }

  // ---------- steps ----------

  async runSteps(steps: Step[], vars?: TemplateVars) {
    for (const step of steps) await this.runStep(step, vars ?? await this.gatherVars());
  }

  private async runStep(step: Step, vars: TemplateVars) {
    if ('command' in step) {
      // Avoid nested enqueue deadlock when a step invokes our own cycle command.
      if (step.command === 'macropad.cycleModelEffort') {
        const raw = step.args;
        const dir =
          raw === 'prev' || raw === 'next'
            ? raw
            : (raw && typeof raw === 'object' && (raw as { dir?: string }).dir === 'prev' ? 'prev' : 'next');
        await this.cycleModelEffort(dir);
        return;
      }
      try {
        await vscode.commands.executeCommand(step.command, ...(step.args === undefined ? [] : [step.args]));
      } catch (err) {
        if (!step.optional) throw err;
        this.out.appendLine(`(optional command ${step.command} failed: ${String(err)})`);
      }
    } else if ('keys' in step) {
      await sendKeys(step.keys, this.cfg.bridge);
      await sleep(this.cfg.defaults.afterKeysDelayMs);
    } else if ('terminal' in step) {
      const name = step.name ?? 'Macropad';
      const term = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal({ name, cwd: this.workspaceRoot() });
      term.show(true);
      term.sendText(render(step.terminal, vars));
    } else if ('shell' in step) {
      const cmd = render(step.shell, vars);
      this.out.appendLine(`$ ${cmd}`);
      const { stdout, stderr } = await exec('/bin/zsh', ['-lc', cmd], { cwd: this.workspaceRoot() });
      if (stdout) this.out.appendLine(stdout.trimEnd());
      if (stderr) this.out.appendLine(stderr.trimEnd());
    } else if ('prompt' in step) {
      await this.sendPrompt(step.prompt, step.mode ?? this.sendMode, vars);
    } else if ('chat' in step) {
      const steps = this.cfg.chat[step.chat];
      if (!steps) throw new Error(`Unknown chat action "${step.chat}"`);
      await this.runSteps(steps, vars);
    } else if ('browser' in step) {
      await this.browser(step.browser);
    } else if ('delay' in step) {
      await sleep(step.delay);
    } else if ('notify' in step) {
      vscode.window.showInformationMessage(render(step.notify, vars));
    }
  }

  // ---------- browser ----------

  /** Uses Cursor's internal browserView commands; headless tabs belong to agent automation. */
  private async browser(op: 'focusOrNew' | 'new') {
    if (op === 'focusOrNew') {
      try {
        const list = await vscode.commands.executeCommand<{ tabs?: string[]; lastInteractedTab?: string; headlessTabs?: string[] }>('cursor.browserView.listTabs');
        const headless = new Set(list?.headlessTabs ?? []);
        const tabs = (list?.tabs ?? []).filter((id) => !headless.has(id));
        const target = list?.lastInteractedTab && tabs.includes(list.lastInteractedTab) ? list.lastInteractedTab : tabs[0];
        if (target) {
          const res = await vscode.commands.executeCommand<{ success?: boolean }>('cursor.browserView.focusOrShowTab', target);
          if (res?.success) return;
        }
      } catch (err) {
        this.out.appendLine(`(browser focus failed, opening a new tab: ${String(err)})`);
      }
    }
    await vscode.commands.executeCommand('workbench.action.newBrowserTab');
  }

  // ---------- prompts ----------

  async sendPrompt(id: string, mode: SendMode, vars?: TemplateVars) {
    this.ensureLoaded();
    const prompt = this.prompts.get(id);
    if (!prompt) throw new Error(`No prompt "${id}" in ${this.cfg.promptsDir}`);
    const text = render(prompt.body, vars ?? await this.gatherVars());
    const previous = await vscode.env.clipboard.readText();

    await this.runSteps(mode === 'newChat+send' ? this.cfg.chat.newChat : this.cfg.chat.focus, vars);
    await vscode.env.clipboard.writeText(text);
    await sendKeys('cmd+v', this.cfg.bridge);
    if (mode !== 'paste') {
      await sleep(this.cfg.defaults.beforeSendDelayMs);
      await this.runSteps(this.cfg.chat.send, vars);
    }
    this.flash(`Prompt: ${prompt.title} (${mode})`);
    setTimeout(() => { void vscode.env.clipboard.writeText(previous); }, 1500);
  }

  /** Values available to prompt templates and terminal/shell steps. */
  async gatherVars(): Promise<TemplateVars> {
    const editor = vscode.window.activeTextEditor;
    const vars: TemplateVars = {
      selection: '', file: '', language: '', problems: '', clipboard: '', workspace: this.workspaceRoot() ?? '',
    };
    try { vars.clipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }
    if (!editor) return vars;
    const doc = editor.document;
    vars.selection = editor.selections.map((s) => doc.getText(s)).filter(Boolean).join('\n\n');
    vars.file = vscode.workspace.asRelativePath(doc.uri);
    vars.language = doc.languageId;
    vars.problems = vscode.languages.getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .map((d) => `- L${d.range.start.line + 1}: [${d.severity === 0 ? 'error' : 'warning'}] ${d.message}${d.source ? ` (${d.source})` : ''}`)
      .join('\n');
    return vars;
  }

  // ---------- cycles (knobs) ----------

  private async cycleItems(name: string, def: CycleDef): Promise<CycleItem[]> {
    switch (def.source) {
      case 'prompts':
        return this.promptList.map((p) => ({ label: p.title, select: () => this.sendPrompt(p.id, this.sendMode) }));
      case 'sendModes':
        return SEND_MODES.map((m) => ({
          label: m,
          onFocus: () => { this.sendMode = m; },
          select: () => this.runSteps(this.cfg.chat.send),
        }));
      case 'gitBranches': {
        const branches = await this.recentBranches(def.count ?? 15);
        return branches.map((b) => ({
          label: b,
          select: async () => {
            await exec('git', ['checkout', b], { cwd: this.workspaceRoot() });
            this.branchCache = undefined;
            vscode.window.showInformationMessage(`Checked out ${b}`);
          },
        }));
      }
      case 'cursorModels': {
        const models = await this.preferredModels(def.includeAuto !== false);
        return models.map((m) => ({
          label: m.label,
          select: () => {
            this.lastEffort = undefined;
            return this.switchComposerModel(m);
          },
        }));
      }
      case 'list':
        return def.items.map((it) => ({ label: it.label, select: () => this.runSteps(it.steps) }));
      default:
        throw new Error(`Unknown cycle source in "${name}"`);
    }
  }

  async cycle(name: string, op: 'next' | 'prev' | 'select') {
    const def = this.cfg.cycles[name];
    if (!def) throw new Error(`No cycle "${name}" in config`);
    const items = await this.cycleItems(name, def);
    if (items.length === 0) { this.flash(`${def.label}: empty`); return; }
    let i = this.cycleIndex.get(name) ?? (def.source === 'sendModes' ? SEND_MODES.indexOf(this.sendMode) : 0);
    i = ((i % items.length) + items.length) % items.length;
    if (op === 'select') {
      await items[i].select();
      return;
    }
    i = (i + (op === 'next' ? 1 : -1) + items.length) % items.length;
    this.cycleIndex.set(name, i);
    items[i].onFocus?.();
    this.status.text = `$(settings-gear) ${def.label}: ${items[i].label}  (${i + 1}/${items.length})`;
    const applyOnNavigate =
      (def.source === 'list' && !!def.applyOnNavigate) ||
      (def.source === 'cursorModels' && def.applyOnNavigate !== false);
    this.status.tooltip = applyOnNavigate
      ? `Macropad — ${def.label}: ${items[i].label}`
      : `Macropad — press the knob to use "${items[i].label}"`;
    if (applyOnNavigate) await items[i].select();
  }

  private async preferredModels(includeAuto: boolean): Promise<CursorModelChoice[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 10_000) return this.modelsCache.items;
    try {
      const items = await loadCursorPreferredModels({ includeAuto });
      this.modelsCache = { at: Date.now(), items };
      return items;
    } catch (err) {
      this.out.appendLine(`cursorModels: failed to read Cursor model list: ${String(err)}`);
      this.flash('Model list unavailable');
      return includeAuto
        ? [{ modelId: 'default', label: 'Auto', modelIdWithParams: JSON.stringify({ modelId: 'default', params: [] }) }]
        : [];
    }
  }

  private async switchComposerModel(m: CursorModelChoice) {
    try {
      await vscode.commands.executeCommand('cursorai.action.switchToModelSlug', {
        modelIdWithParams: m.modelIdWithParams,
      });
      this.notifyDisplaySelection(m);
      this.out.appendLine(`Switched composer model → ${m.label} (${m.modelId})`);
    } catch (err) {
      this.out.appendLine(`switchToModelSlug failed for ${m.modelId}: ${String(err)}`);
      throw err;
    }
  }

  /** Tell the local display bridge immediately; Cursor hooks only update on agent events. */
  private notifyDisplaySelection(m: CursorModelChoice) {
    let params: unknown[] = [];
    try {
      const parsed = JSON.parse(m.modelIdWithParams) as { params?: unknown[] };
      params = Array.isArray(parsed.params) ? parsed.params : [];
    } catch { /* the Cursor command already accepted this value */ }
    postToDisplayBridge('/selection', { model: m.modelId, params });
  }

  /** Cycle the active agent's effort/thinking level when the model exposes one. */
  async cycleModelEffort(dir: 'next' | 'prev' = 'next') {
    try {
      const hint = this.lastEffort && Date.now() - this.lastEffort.at < 3000 ? this.lastEffort : undefined;
      const next = await cycleCurrentModelEffort(dir, hint);
      if (!next) {
        this.lastEffort = undefined;
        this.flash('No effort levels');
        this.out.appendLine('cycleModelEffort: current model has no cycleable effort/thinking param');
        return;
      }
      this.lastEffort = { modelId: next.modelId, paramId: next.paramId, value: next.value, at: Date.now() };
      this.modelsCache = undefined;
      await this.switchComposerModel(next);
      this.flash(`${next.paramName}: ${next.displayValue}`);
    } catch (err) {
      this.out.appendLine(`cycleModelEffort failed: ${String(err)}`);
      throw err;
    }
  }

  private async recentBranches(count: number): Promise<string[]> {
    if (this.branchCache && Date.now() - this.branchCache.at < 10_000) return this.branchCache.items;
    const { stdout } = await exec('git', ['for-each-ref', '--sort=-committerdate', `--count=${count}`, '--format=%(refname:short)', 'refs/heads'], { cwd: this.workspaceRoot() });
    const items = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    this.branchCache = { at: Date.now(), items };
    return items;
  }

  // ---------- helpers ----------

  workspaceRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath;
  }

  private idleStatus() {
    this.status.text = `$(keyboard) Macropad · ${this.sendMode}`;
    this.status.tooltip = 'Macropad — click to open config';
  }

  private flashTimer?: NodeJS.Timeout;
  flash(text: string) {
    this.status.text = `$(keyboard) ${text}`;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.idleStatus(), 3000);
  }
}
