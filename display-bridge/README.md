# display-bridge

Sends Cursor's agent state to the desk display (`../firmware/display`).

```
Cursor hooks ──▶ forward-hook.sh ──▶ bridge.mjs (127.0.0.1:47321, launchd) ──▶ POST http://<clock>/state
Macropad model/effort controls ─────▶ POST /selection ─────────────────────────▶
```

## Install

```sh
node display-bridge/install.mjs            # copies files to ~/.cursor-display, adds hooks, starts the service
curl -s 127.0.0.1:47321/state              # what the bridge would show right now
tail -f ~/.cursor-display/bridge.log
```

Re-run `install.mjs` after changing `bridge.mjs` or `config.json`. Use `--uninstall` to remove the hooks and the service. Your `~/.cursor/hooks.json` is backed up each time, and any hooks you already have are kept.

The hooks only observe (session, prompt submitted, thoughts, tool results, subagents, compaction, stop). They print nothing and always exit 0, so they can't approve, block or slow the agent (1 s cap).

The macropad extension posts the newly selected model and parameters to the
bridge's local-only `POST /selection` endpoint. This updates the display
immediately instead of waiting for Cursor's next agent hook.

## Where each value comes from

| On screen                                 | Source                                                                                                                                                           | Accuracy |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| State (thinking / working / idle / error) | `beforeSubmitPrompt`, `afterAgentThought`, tool hooks, `stop`                                                                                                    | good     |
| Agents                                    | conversations with a turn in progress, plus running subagents                                                                                                    | good     |
| Model, effort                             | the conversation's model picker selection (`composerData.modelConfig`); macropad changes via `POST /selection` show instantly                                    | exact    |
| Mode                                      | `sessionStart.composer_mode`                                                                                                                                     | good     |
| Project, branch                           | focused window (macropad extension, `POST /window`) when idle, the running agent's `workspace_roots` while busy; branch read from `.git/HEAD`, checked every 2 s | exact    |
| Context % and breakdown                   | Cursor's own figures from `composerData:<conversation>` in `state.vscdb` (read-only); falls back to a transcript-size estimate                                   | exact    |
| Tokens used                               | sum of today's transcript estimates                                                                                                                              | estimate |

Cursor's hooks don't report real token usage. Getting it would need Cursor's local database (`state.vscdb`) or its usage API, which is a possible next step.

`~/.cursor-display/events.jsonl` logs hook **metadata only** (event name, ids, model, model_params, status, field names). No prompts, responses, code or tool output. Set `"logEvents": false` in `config.json` to turn it off.
