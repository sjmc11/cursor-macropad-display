#!/usr/bin/env node
// Installs the Cursor -> display bridge for the current macOS user.
//
//   node display-bridge/install.mjs              install / update
//   node display-bridge/install.mjs --uninstall  remove hooks + background service
//
// What it does:
//   1. Copies bridge.mjs, forward-hook.sh and config.json to ~/.cursor-display/
//      (launchd services can't read ~/Documents without extra permissions).
//   2. Adds observational hooks to ~/.cursor/hooks.json (backs the file up first,
//      keeps any hooks you already have). The hooks only forward the event to
//      the bridge; they print nothing and never block the agent.
//   3. Registers a launchd agent (com.macropad.cursor-display) that keeps the
//      bridge running and starts it at login.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DEST = path.join(HOME, '.cursor-display');
const HOOKS = path.join(HOME, '.cursor', 'hooks.json');
const LABEL = 'com.macropad.cursor-display';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const FORWARD = path.join(DEST, 'forward-hook.sh');
const UID = process.getuid();

// Only events that observe; none of these can approve or deny anything.
const EVENTS = [
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterAgentThought', 'afterAgentResponse',
  'postToolUse', 'postToolUseFailure', 'afterFileEdit', 'afterShellExecution', 'afterMCPExecution',
  'subagentStart', 'subagentStop', 'preCompact', 'stop',
];

const uninstall = process.argv.includes('--uninstall');

function launchctl(...args) {
  try { execFileSync('launchctl', args, { stdio: 'ignore' }); } catch { /* not loaded */ }
}

function updateHooks() {
  let cfg = { version: 1, hooks: {} };
  if (fs.existsSync(HOOKS)) {
    const raw = fs.readFileSync(HOOKS, 'utf8');
    try { cfg = JSON.parse(raw); } catch { throw new Error(`${HOOKS} isn't valid JSON; fix it and re-run.`); }
    const backup = `${HOOKS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw);
    console.log(`Backed up ${HOOKS} -> ${backup}`);
  }
  cfg.version ??= 1;
  cfg.hooks ??= {};
  for (const ev of Object.keys(cfg.hooks)) {
    cfg.hooks[ev] = (cfg.hooks[ev] || []).filter((h) => h.command !== FORWARD);
    if (cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
  }
  if (!uninstall) {
    for (const ev of EVENTS) (cfg.hooks[ev] ??= []).push({ command: FORWARD, timeout: 2 });
  }
  fs.mkdirSync(path.dirname(HOOKS), { recursive: true });
  fs.writeFileSync(HOOKS, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`${uninstall ? 'Removed' : 'Added'} display hooks in ${HOOKS}`);
}

function plist() {
  const log = path.join(DEST, 'bridge.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(DEST, 'bridge.mjs')}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

if (uninstall) {
  launchctl('bootout', `gui/${UID}/${LABEL}`);
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  updateHooks();
  console.log(`Stopped the bridge. ${DEST} was left in place (logs); delete it if you like.`);
  process.exit(0);
}

fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(path.join(HERE, 'bridge.mjs'), path.join(DEST, 'bridge.mjs'));
fs.copyFileSync(path.join(HERE, 'forward-hook.sh'), FORWARD);
fs.chmodSync(FORWARD, 0o755);
const cfgSrc = fs.existsSync(path.join(HERE, 'config.json')) ? 'config.json' : 'config.example.json';
fs.copyFileSync(path.join(HERE, cfgSrc), path.join(DEST, 'config.json'));
console.log(`Copied bridge files to ${DEST}`);

updateHooks();

fs.mkdirSync(path.dirname(PLIST), { recursive: true });
fs.writeFileSync(PLIST, plist());
launchctl('bootout', `gui/${UID}/${LABEL}`);
execFileSync('launchctl', ['bootstrap', `gui/${UID}`, PLIST], { stdio: 'inherit' });
console.log(`Started ${LABEL} (node ${process.version}). Check: curl -s 127.0.0.1:47321/state`);
