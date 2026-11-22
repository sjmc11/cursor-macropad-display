import * as vscode from 'vscode';
import { Engine } from './engine';
import { SEND_MODES, SendMode, expandHome } from './config';
import { ping } from './bridge';
import { postToDisplayBridge } from './displayBridge';

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Macropad');
  const engine = new Engine(out);
  context.subscriptions.push(out, engine);

  try { engine.ensureLoaded(true); } catch (err) {
    vscode.window.showWarningMessage(`Macropad: couldn't load config — ${String(err)}`);
  }

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('macropad.input', (id?: string) => {
    if (!id) { vscode.window.showWarningMessage('macropad.input needs an input id, e.g. "L1.K1"'); return; }
    engine.triggerInput(id);
  });

  reg('macropad.pastePrompt', async (arg?: { id: string; mode?: SendMode }) => {
    let id = arg?.id;
    let mode = arg?.mode;
    if (!id) {
      const pick = await vscode.window.showQuickPick(engine.promptList.map((p) => ({ label: p.title, description: p.id })), { placeHolder: 'Prompt to paste' });
      if (!pick) return;
      id = pick.description!;
      mode = (await vscode.window.showQuickPick(SEND_MODES, { placeHolder: 'Send mode' })) as SendMode | undefined;
      if (!mode) return;
    }
    const vars = await engine.gatherVars();
    engine.enqueue(`prompt ${id}`, () => engine.sendPrompt(id!, mode ?? engine.config.defaults.sendMode, vars));
  });

  reg('macropad.reloadConfig', () => {
    try { engine.ensureLoaded(true); vscode.window.showInformationMessage('Macropad config reloaded'); }
    catch (err) { vscode.window.showErrorMessage(`Macropad: ${String(err)}`); }
  });

  reg('macropad.openConfig', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(expandHome(engine.configPath)));
    await vscode.window.showTextDocument(doc);
  });

  reg('macropad.findCommands', async () => {
    const filter = await vscode.window.showInputBox({ prompt: 'Filter command IDs (e.g. composer, aichat, cursor, chat)', value: 'composer' });
    if (filter === undefined) return;
    const all = await vscode.commands.getCommands(true);
    const hits = all.filter((c) => c.toLowerCase().includes(filter.toLowerCase())).sort();
    out.appendLine(`\n# ${hits.length} commands matching "${filter}"`);
    hits.forEach((c) => out.appendLine(c));
    out.show(true);
  });

  reg('macropad.testBridge', async () => {
    try {
      await ping(engine.config.bridge);
      vscode.window.showInformationMessage('Macropad: Hammerspoon bridge is working');
    } catch (err) {
      vscode.window.showErrorMessage(`Macropad: ${String(err instanceof Error ? err.message : err)}`);
    }
  });

  reg('macropad.exportCommands', () => engine.exportCommands());

  reg('macropad.cycleModelEffort', (arg?: { dir?: 'next' | 'prev' } | 'next' | 'prev') => {
    const dir = typeof arg === 'string' ? arg : (arg?.dir ?? 'next');
    engine.enqueue('cycleModelEffort', () => engine.cycleModelEffort(dir));
  });

  // Tell the desk display which project window is in front.
  const reportWindow = () => {
    if (!vscode.window.state.focused) return;
    const root = engine.workspaceRoot();
    if (root) postToDisplayBridge('/window', { root });
  };
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(reportWindow),
    vscode.window.onDidChangeActiveTextEditor(reportWindow),
  );
  reportWindow();

  // Export commands on activation so the Studio app always has an up-to-date list.
  engine.exportCommands();
}

export function deactivate() {}
