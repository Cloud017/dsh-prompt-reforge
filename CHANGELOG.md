# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-21

First release under the `dsh-prompt-reforge` name. This is a from-scratch rewrite of an earlier private prototype; the interaction is the same, the code is not.

### Added

- Composer control in the `conversation.input.right` slot, sitting next to the model selector, with no panel and no modal: the rewrite lands in the draft you are already editing.
- One-click revert: the same button turns into *Restore the original draft* after a successful rewrite.
- Cancel by pressing the button again while a rewrite is in flight.
- Per-session button state kept outside React so it survives composer remounts; in-flight calls are identified by `AbortController` identity, so a late response from a cancelled call cannot overwrite the draft.
- Draft-divergence detection: typing after a rewrite drops the backup instead of offering a revert that would discard the edit.
- Explicit reasons for an inert button — empty draft, no model selected, over-long draft, reference chips in the draft.
- `POST /plugins/dsh-prompt-reforge/enhance` host route with a loopback-only guard, a 256 KiB body cap, a 20 000-character draft cap, a 60 s budget, and abort-on-disconnect.
- `node --test` suite (65 tests) covering the prompt pipeline, the route, the loopback guard over a raw socket, and the button state machine against a minimal React stand-in.

### Changed

- The system prompt and user template are written for this package rather than copied from another product; the behavioural contract (mirror the draft's language, stay near 800 characters, return only the prompt, never answer the request) is unchanged.
- Output normalization also unwraps a fenced block, strips a leading `Enhanced prompt:`-style label, and removes wrapping quotes — including CJK ones.
- Failures are classified into distinct statuses (`aborted`, `timeout`, `empty_result`, upstream codes) instead of collapsing into one generic error.
- The host half imports nothing from `@deepseek-ai/*` and reaches the LLM runtime through `ctx.get('llm')`, so the package installs without pulling peer dependencies.

## [0.1.0] — private prototype

Never published. Single-file host and browser halves, no tests, hard-coded prompt strings.
