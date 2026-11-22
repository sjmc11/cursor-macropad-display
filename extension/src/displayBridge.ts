import * as http from 'http';

/** Fire-and-forget POST to the desk display bridge (display-bridge/bridge.mjs). It's optional, so errors are ignored. */
export function postToDisplayBridge(path: string, value: unknown) {
  const body = JSON.stringify(value);
  const req = http.request({
    hostname: '127.0.0.1',
    port: 47321,
    path,
    method: 'POST',
    timeout: 500,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => { /* bridge not running */ });
  req.end(body);
}
