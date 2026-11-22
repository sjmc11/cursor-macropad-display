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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const engine_1 = require("./engine");
const config_1 = require("./config");
const bridge_1 = require("./bridge");
const displayBridge_1 = require("./displayBridge");
function activate(context) {
    const out = vscode.window.createOutputChannel('Macropad');
    const engine = new engine_1.Engine(out);
    context.subscriptions.push(out, engine);
    try {
        engine.ensureLoaded(true);
    }
    catch (err) {
        vscode.window.showWarningMessage(`Macropad: couldn't load config — ${String(err)}`);
    }
    const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg('macropad.input', (id) => {
        if (!id) {
            vscode.window.showWarningMessage('macropad.input needs an input id, e.g. "L1.K1"');
            return;
        }
        engine.triggerInput(id);
    });
    reg('macropad.pastePrompt', async (arg) => {
        let id = arg?.id;
        let mode = arg?.mode;
        if (!id) {
            const pick = await vscode.window.showQuickPick(engine.promptList.map((p) => ({ label: p.title, description: p.id })), { placeHolder: 'Prompt to paste' });
            if (!pick)
                return;
            id = pick.description;
            mode = (await vscode.window.showQuickPick(config_1.SEND_MODES, { placeHolder: 'Send mode' }));
            if (!mode)
                return;
        }
        const vars = await engine.gatherVars();
        engine.enqueue(`prompt ${id}`, () => engine.sendPrompt(id, mode ?? engine.config.defaults.sendMode, vars));
    });
    reg('macropad.reloadConfig', () => {
        try {
            engine.ensureLoaded(true);
            vscode.window.showInformationMessage('Macropad config reloaded');
        }
        catch (err) {
            vscode.window.showErrorMessage(`Macropad: ${String(err)}`);
        }
    });
    reg('macropad.openConfig', async () => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file((0, config_1.expandHome)(engine.configPath)));
        await vscode.window.showTextDocument(doc);
    });
    reg('macropad.findCommands', async () => {
        const filter = await vscode.window.showInputBox({ prompt: 'Filter command IDs (e.g. composer, aichat, cursor, chat)', value: 'composer' });
        if (filter === undefined)
            return;
        const all = await vscode.commands.getCommands(true);
        const hits = all.filter((c) => c.toLowerCase().includes(filter.toLowerCase())).sort();
        out.appendLine(`\n# ${hits.length} commands matching "${filter}"`);
        hits.forEach((c) => out.appendLine(c));
        out.show(true);
    });
    reg('macropad.testBridge', async () => {
        try {
            await (0, bridge_1.ping)(engine.config.bridge);
            vscode.window.showInformationMessage('Macropad: Hammerspoon bridge is working');
        }
        catch (err) {
            vscode.window.showErrorMessage(`Macropad: ${String(err instanceof Error ? err.message : err)}`);
        }
    });
    reg('macropad.exportCommands', () => engine.exportCommands());
    reg('macropad.cycleModelEffort', (arg) => {
        const dir = typeof arg === 'string' ? arg : (arg?.dir ?? 'next');
        engine.enqueue('cycleModelEffort', () => engine.cycleModelEffort(dir));
    });
    // Tell the desk display which project window is in front.
    const reportWindow = () => {
        if (!vscode.window.state.focused)
            return;
        const root = engine.workspaceRoot();
        if (root)
            (0, displayBridge_1.postToDisplayBridge)('/window', { root });
    };
    context.subscriptions.push(vscode.window.onDidChangeWindowState(reportWindow), vscode.window.onDidChangeActiveTextEditor(reportWindow));
    reportWindow();
    // Export commands on activation so the Studio app always has an up-to-date list.
    engine.exportCommands();
}
function deactivate() { }
//# sourceMappingURL=extension.js.map