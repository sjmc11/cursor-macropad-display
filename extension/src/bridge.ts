import * as fs from 'fs';
import { expandHome } from './config';

export class BridgeError extends Error {}

/** Sends a key combo (e.g. "cmd+shift+l") to the frontmost app via the Hammerspoon bridge. */
export async function sendKeys(combo: string, bridge: { port: number; tokenFile: string }): Promise<void> {
  let token: string;
  try {
    token = fs.readFileSync(expandHome(bridge.tokenFile), 'utf8').trim();
  } catch {
    throw new BridgeError(`No bridge token at ${bridge.tokenFile}. Is the Hammerspoon macropad module loaded?`);
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/keys`, {
      method: 'POST',
      headers: { 'X-Macropad-Token': token, 'Content-Type': 'text/plain' },
      body: combo,
    });
  } catch {
    throw new BridgeError('Hammerspoon bridge is not reachable. Open Hammerspoon and reload its config.');
  }
  if (!res.ok) throw new BridgeError(`Bridge refused "${combo}": ${res.status} ${await res.text()}`);
}

/** Checks the bridge is up and the token matches, without sending any keys. */
export async function ping(bridge: { port: number; tokenFile: string }): Promise<void> {
  let token = '';
  try { token = fs.readFileSync(expandHome(bridge.tokenFile), 'utf8').trim(); }
  catch { throw new BridgeError(`No bridge token at ${bridge.tokenFile}. Is the Hammerspoon macropad module loaded?`); }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/ping`, { method: 'POST', headers: { 'X-Macropad-Token': token } });
  } catch {
    throw new BridgeError('Hammerspoon bridge is not reachable. Open Hammerspoon and reload its config.');
  }
  if (!res.ok) throw new BridgeError(`Bridge responded ${res.status}: ${await res.text()}`);
}
