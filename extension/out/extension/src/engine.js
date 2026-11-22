"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Engine = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const config_1 = require("./config");
const bridge_1 = require("./bridge");
const template_1 = require("./template");
const cursorModels_1 = require("./cursorModels");
const displayBridge_1 = require("./displayBridge");
const exec = (0, util_1.promisify)(child_process_1.execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const macropadDir = path.join(os.homedir(), '.macropad');
class Engine {
    out;
    cfg;
    prompts = new Map();
    fp = '';
    sendMode = 'paste+send';
    cycleIndex = new Map();
    branchCache;
    modelsCache;
    lastEffort;
    queue = Promise.resolve();
    status;
    constructor(out) {
        this.out = out;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.status.command = 'macropad.openConfig';
        this.status.show();
    }
    dispose() { this.status.dispose(); }
    get configPath() {
        return vscode.workspace.getConfiguration('macropad').get('configPath');
    }
    get config() { this.ensureLoaded(); return this.cfg; }
    get promptList() { this.ensureLoaded(); return [...this.prompts.values()]; }
    /** Loads config/prompts if files changed since last load. */
    ensureLoaded(force = false) {
        const promptsDir = this.cfg?.promptsDir ?? '';
        const fp = (0, config_1.fingerprint)(this.configPath, promptsDir);
        if (!force && this.cfg && fp === this.fp)
            return;
        const firstLoad = !this.cfg;
        this.cfg = (0, config_1.loadConfig)(this.configPath);
        this.prompts = (0, config_1.loadPrompts)(this.cfg.promptsDir);
        this.fp = (0, config_1.fingerprint)(this.configPath, this.cfg.promptsDir);
        if (firstLoad)
            this.sendMode = this.cfg.defaults.sendMode;
        this.out.appendLine(`Loaded ${Object.keys(this.cfg.inputs).length} inputs, ${this.prompts.size} prompts from ${this.configPath}`);
        this.idleStatus();
    }
    /** Serialises work so fast knob spins don't interleave keystrokes. */
    enqueue(label, fn) {
        this.queue = this.queue.then(fn).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.out.appendLine(`[${label}] ${msg}`);
            vscode.window.showErrorMessage(`Macropad – ${label}: ${msg}`);
        });
        return this.queue;
    }
    triggerInput(id) {
        this.enqueue(id, async () => {
            this.ensureLoaded();
            const action = this.cfg.inputs[id];
            if (!action) {
                this.flash(`${id}: unassigned`);
                return;
            }
            this.out.appendLine(`→ ${id} (${action.label})`);
            this.writeLastInput(id, action.label);
            await this.runAction(action);
        });
    }
    /** Write ~/.macropad/last-input.json so the Studio app can highlight the pressed key. */
    writeLastInput(id, label) {
        try {
            fs.mkdirSync(macropadDir, { recursive: true });
            fs.writeFileSync(path.join(macropadDir, 'last-input.json'), JSON.stringify({ id, label, at: Date.now() }));
        }
        catch { /* best effort */ }
    }
    /** Write ~/.macropad/commands.json with all known command ids for autocomplete. */
    async exportCommands() {
        const all = await vscode.commands.getCommands(true);
        all.sort();
        try {
            fs.mkdirSync(macropadDir, { recursive: true });
            fs.writeFileSync(path.join(macropadDir, 'commands.json'), JSON.stringify(all));
            this.out.appendLine(`Exported ${all.length} command ids to ~/.macropad/commands.json`);
        }
        catch (err) {
            this.out.appendLine(`Failed to export commands: ${String(err)}`);
        }
    }
    async runAction(action) {
        if ('steps' in action) {
            const vars = await this.gatherVars();
            await this.runSteps(action.steps, vars);
            return;
        }
        await this.cycle(action.cycle, action.do);
    }
    // ---------- steps ----------
    async runSteps(steps, vars) {
        for (const step of steps)
            await this.runStep(step, vars ?? await this.gatherVars());
    }
    async runStep(step, vars) {
        if ('command' in step) {
            // Avoid nested enqueue deadlock when a step invokes our own cycle command.
            if (step.command === 'macropad.cycleModelEffort') {
                const raw = step.args;
                const dir = raw === 'prev' || raw === 'next'
                    ? raw
                    : (raw && typeof raw === 'object' && raw.dir === 'prev' ? 'prev' : 'next');
                await this.cycleModelEffort(dir);
                return;
            }
            try {
                await vscode.commands.executeCommand(step.command, ...(step.args === undefined ? [] : [step.args]));
            }
            catch (err) {
                if (!step.optional)
                    throw err;
                this.out.appendLine(`(optional command ${step.command} failed: ${String(err)})`);
            }
        }
        else if ('keys' in step) {
            await (0, bridge_1.sendKeys)(step.keys, this.cfg.bridge);
            await sleep(this.cfg.defaults.afterKeysDelayMs);
        }
        else if ('terminal' in step) {
            const name = step.name ?? 'Macropad';
            const term = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal({ name, cwd: this.workspaceRoot() });
            term.show(true);
            term.sendText((0, template_1.render)(step.terminal, vars));
        }
        else if ('shell' in step) {
            const cmd = (0, template_1.render)(step.shell, vars);
            this.out.appendLine(`$ ${cmd}`);
            const { stdout, stderr } = await exec('/bin/zsh', ['-lc', cmd], { cwd: this.workspaceRoot() });
            if (stdout)
                this.out.appendLine(stdout.trimEnd());
            if (stderr)
                this.out.appendLine(stderr.trimEnd());
        }
        else if ('prompt' in step) {
            await this.sendPrompt(step.prompt, step.mode ?? this.sendMode, vars);
        }
        else if ('chat' in step) {
            const steps = this.cfg.chat[step.chat];
            if (!steps)
                throw new Error(`Unknown chat action "${step.chat}"`);
            await this.runSteps(steps, vars);
        }
        else if ('browser' in step) {
            await this.browser(step.browser);
        }
        else if ('delay' in step) {
            await sleep(step.delay);
        }
        else if ('notify' in step) {
            vscode.window.showInformationMessage((0, template_1.render)(step.notify, vars));
        }
    }
    // ---------- browser ----------
    /** Uses Cursor's internal browserView commands; headless tabs belong to agent automation. */
    async browser(op) {
        if (op === 'focusOrNew') {
            try {
                const list = await vscode.commands.executeCommand('cursor.browserView.listTabs');
                const headless = new Set(list?.headlessTabs ?? []);
                const tabs = (list?.tabs ?? []).filter((id) => !headless.has(id));
                const target = list?.lastInteractedTab && tabs.includes(list.lastInteractedTab) ? list.lastInteractedTab : tabs[0];
                if (target) {
                    const res = await vscode.commands.executeCommand('cursor.browserView.focusOrShowTab', target);
                    if (res?.success)
                        return;
                }
            }
            catch (err) {
                this.out.appendLine(`(browser focus failed, opening a new tab: ${String(err)})`);
            }
        }
        await vscode.commands.executeCommand('workbench.action.newBrowserTab');
    }
    // ---------- prompts ----------
    async sendPrompt(id, mode, vars) {
        this.ensureLoaded();
        const prompt = this.prompts.get(id);
        if (!prompt)
            throw new Error(`No prompt "${id}" in ${this.cfg.promptsDir}`);
        const text = (0, template_1.render)(prompt.body, vars ?? await this.gatherVars());
        const previous = await vscode.env.clipboard.readText();
        await this.runSteps(mode === 'newChat+send' ? this.cfg.chat.newChat : this.cfg.chat.focus, vars);
        await vscode.env.clipboard.writeText(text);
        await (0, bridge_1.sendKeys)('cmd+v', this.cfg.bridge);
        if (mode !== 'paste') {
            await sleep(this.cfg.defaults.beforeSendDelayMs);
            await this.runSteps(this.cfg.chat.send, vars);
        }
        this.flash(`Prompt: ${prompt.title} (${mode})`);
        setTimeout(() => { void vscode.env.clipboard.writeText(previous); }, 1500);
    }
    /** Values available to prompt templates and terminal/shell steps. */
    async gatherVars() {
        const editor = vscode.window.activeTextEditor;
        const vars = {
            selection: '', file: '', language: '', problems: '', clipboard: '', workspace: this.workspaceRoot() ?? '',
        };
        try {
            vars.clipboard = await vscode.env.clipboard.readText();
        }
        catch { /* ignore */ }
        if (!editor)
            return vars;
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
    async cycleItems(name, def) {
        switch (def.source) {
            case 'prompts':
                return this.promptList.map((p) => ({ label: p.title, select: () => this.sendPrompt(p.id, this.sendMode) }));
            case 'sendModes':
                return config_1.SEND_MODES.map((m) => ({
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
    async cycle(name, op) {
        const def = this.cfg.cycles[name];
        if (!def)
            throw new Error(`No cycle "${name}" in config`);
        const items = await this.cycleItems(name, def);
        if (items.length === 0) {
            this.flash(`${def.label}: empty`);
            return;
        }
        let i = this.cycleIndex.get(name) ?? (def.source === 'sendModes' ? config_1.SEND_MODES.indexOf(this.sendMode) : 0);
        i = ((i % items.length) + items.length) % items.length;
        if (op === 'select') {
            await items[i].select();
            return;
        }
        i = (i + (op === 'next' ? 1 : -1) + items.length) % items.length;
        this.cycleIndex.set(name, i);
        items[i].onFocus?.();
        this.status.text = `$(settings-gear) ${def.label}: ${items[i].label}  (${i + 1}/${items.length})`;
        const applyOnNavigate = (def.source === 'list' && !!def.applyOnNavigate) ||
            (def.source === 'cursorModels' && def.applyOnNavigate !== false);
        this.status.tooltip = applyOnNavigate
            ? `Macropad — ${def.label}: ${items[i].label}`
            : `Macropad — press the knob to use "${items[i].label}"`;
        if (applyOnNavigate)
            await items[i].select();
    }
    async preferredModels(includeAuto) {
        if (this.modelsCache && Date.now() - this.modelsCache.at < 10_000)
            return this.modelsCache.items;
        try {
            const items = await (0, cursorModels_1.loadCursorPreferredModels)({ includeAuto });
            this.modelsCache = { at: Date.now(), items };
            return items;
        }
        catch (err) {
            this.out.appendLine(`cursorModels: failed to read Cursor model list: ${String(err)}`);
            this.flash('Model list unavailable');
            return includeAuto
                ? [{ modelId: 'default', label: 'Auto', modelIdWithParams: JSON.stringify({ modelId: 'default', params: [] }) }]
                : [];
        }
    }
    async switchComposerModel(m) {
        try {
            await vscode.commands.executeCommand('cursorai.action.switchToModelSlug', {
                modelIdWithParams: m.modelIdWithParams,
            });
            this.notifyDisplaySelection(m);
            this.out.appendLine(`Switched composer model → ${m.label} (${m.modelId})`);
        }
        catch (err) {
            this.out.appendLine(`switchToModelSlug failed for ${m.modelId}: ${String(err)}`);
            throw err;
        }
    }
    /** Tell the local display bridge immediately; Cursor hooks only update on agent events. */
    notifyDisplaySelection(m) {
        let params = [];
        try {
            const parsed = JSON.parse(m.modelIdWithParams);
            params = Array.isArray(parsed.params) ? parsed.params : [];
        }
        catch { /* the Cursor command already accepted this value */ }
        (0, displayBridge_1.postToDisplayBridge)('/selection', { model: m.modelId, params });
    }
    /** Cycle the active agent's effort/thinking level when the model exposes one. */
    async cycleModelEffort(dir = 'next') {
        try {
            const hint = this.lastEffort && Date.now() - this.lastEffort.at < 3000 ? this.lastEffort : undefined;
            const next = await (0, cursorModels_1.cycleCurrentModelEffort)(dir, hint);
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
        }
        catch (err) {
            this.out.appendLine(`cycleModelEffort failed: ${String(err)}`);
            throw err;
        }
    }
    async recentBranches(count) {
        if (this.branchCache && Date.now() - this.branchCache.at < 10_000)
            return this.branchCache.items;
        const { stdout } = await exec('git', ['for-each-ref', '--sort=-committerdate', `--count=${count}`, '--format=%(refname:short)', 'refs/heads'], { cwd: this.workspaceRoot() });
        const items = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        this.branchCache = { at: Date.now(), items };
        return items;
    }
    // ---------- helpers ----------
    workspaceRoot() {
        const editor = vscode.window.activeTextEditor;
        const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
        return folder?.uri.fsPath;
    }
    idleStatus() {
        this.status.text = `$(keyboard) Macropad · ${this.sendMode}`;
        this.status.tooltip = 'Macropad — click to open config';
    }
    flashTimer;
    flash(text) {
        this.status.text = `$(keyboard) ${text}`;
        clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => this.idleStatus(), 3000);
    }
}
exports.Engine = Engine;
//# sourceMappingURL=engine.js.map