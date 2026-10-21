# dsh-prompt-reforge

A composer control for DeepSeek Harness (DSH) that rewrites the draft you are typing into a sharper, more specific prompt — then lets you put the original back with one click.

It sits in the composer toolbar next to the model selector. No panel, no modal: the rewritten prompt lands in the editor you are already looking at.

```
[ + ]  [ permission ]            [ ✨ ]  [ ▾ model ]
                                   │
                                   └─ press to reforge, press again to revert
```

## What it does

| Step | What you see |
| --- | --- |
| Empty draft | The button stays inert and says *"Write something first, then reforge it."* |
| No model selected | Inert, with *"Pick a model first, then reforge."* |
| Draft with reference chips | Inert — rewriting would drop the chips. *"Remove reference chips before reforging."* |
| Ready | The button arms. Press it. |
| Rewriting | Spinner, *"Reforging…"*. Press again to cancel. |
| Rewritten | The draft is replaced. The same button now reads *"Restore the original draft"*. |
| You keep typing | The backup is dropped, so a revert can never silently swallow your edit. |
| Failure | The draft is left untouched and the tooltip carries the reason. |

The rewrite runs against **the model and provider already selected for that session**, so the result matches the assistant you are about to talk to. Your draft is never sent anywhere else.

## Install

From the DSH plugin manager:

```
plugin_manager action=install_bundle target=<absolute path to this directory>
```

Or from the GUI: **Plugins → Add plugin → Install third-party plugin**, paste the package name, a GitHub URL, or a local directory, then restart DSH.

Once installed, `dsh.profile.bundles` gains one entry. The plugin adds exactly one host row; it does not change your model routing, providers, or default model.

## How it works

Two halves, both shipped in this package:

- **Host half** (`lib/index.js`) registers one `POST /plugins/dsh-prompt-reforge/enhance` route on the harness web server. It validates the request, calls `ctx.llm.stream()` on the session's routed model, and returns the normalized text. It refuses non-loopback requests, caps the body at 256 KiB and the draft at 20 000 characters, and aborts the model call if the browser disconnects or the 60 s budget runs out.
- **Browser half** (`lib/client.js`) registers a control into the `conversation.input.right` slot. It owns the button state machine, talks to the route with `fetch`, and writes the result back through the composer's own `inputActions.setDraft`.

The browser bundle declares no dependency beyond React from the module loader; the host half imports nothing from `@deepseek-ai/*` and reaches the LLM runtime through `ctx.get('llm')`.

### Why the state lives outside React

Button state is keyed by session and kept in a module-level map rather than component state. Composer seats are unmounted and remounted freely (switching sessions, resizing, layout changes), and a rewrite in flight must survive that. Aborts are tracked by `AbortController` identity rather than by a sequence counter, so a late response from a cancelled call can never overwrite the draft.

### Request contract

`POST /plugins/dsh-prompt-reforge/enhance`

```json
{ "draft": "rough text", "provider": "workbuddy", "model": "deepseek-v4.1-flash", "sessionId": "session-…" }
```

Success: `200 { "ok": true, "text": "…" }`

Failure: `{ "ok": false, "error": { "code": "…", "message": "…" } }`

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_body` | Body was not a JSON object |
| 400 | `empty_draft` | Nothing to rewrite |
| 400 | `missing_route` | `provider` or `model` missing |
| 403 | `request_not_trusted` | Non-loopback `Host` or foreign `Origin` |
| 405 | `method_not_allowed` | Not a POST |
| 413 | `body_too_large` / `draft_too_long` | Over the size caps |
| 499 | `aborted` | The browser went away |
| 502 | `empty_result` / upstream code | The model produced nothing usable |
| 503 | `llm_unavailable` | No LLM runtime in this composition |
| 504 | `timeout` | Exceeded the 60 s budget |

## Configuration

Nothing to configure. Caps live at the top of `lib/index.js` and `lib/client.js` if you want to fork them:

| Constant | Default | Where |
| --- | --- | --- |
| `MAX_DRAFT_CHARS` | 20 000 | both halves must agree |
| `MAX_BODY_BYTES` | 256 KiB | host |
| `MAX_TOKENS` | 2 048 | host |
| `TIMEOUT_MS` | 60 000 | host |
| `LENGTH_BUDGET` | 800 characters | prompt (`lib/prompts.js`) |

## Development

```sh
node --test          # 65 tests, no dependencies beyond Node
```

The suite covers the prompt pipeline, the route (including loopback rejection driven straight over a socket, since `fetch` cannot forge a `Host` header), and the button state machine against a minimal React stand-in — no DOM, no browser.

Layout:

```
lib/index.js     host half: route, validation, LLM call, error mapping
lib/http.js      loopback guard, JSON responses, bounded body reader
lib/llm.js       stream consumption and failure classification
lib/prompts.js   system prompt, user template, output normalization
lib/client.js    browser half: the composer control
locale/          plugin-list metadata
test/            node:test suites
```

## Compatibility

DSH `0.2.1-rc.1` and newer within `0.3.0`. The `@deepseek-ai/*` peer dependencies are declared optional: they are provided by the harness composition, never installed by this package, and a composition missing one degrades the feature instead of failing the client.

## License

MIT © Cloud017
