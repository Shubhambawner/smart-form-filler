# AGENTS: Smart Semantic Autofill — Agent Instructions

Purpose: help automated coding agents quickly understand this repository and act safely and productively.

Quick facts
- **Type:** Chrome extension (Manifest V3).
- **Entry points:** [manifest.json](manifest.json#L1-L24) → background service worker, [popup.html](popup.html), [content.js](content.js).
- **ML / runtime:** local ONNX/WASM inference via [transformers.js](transformers.js) and ONNX Runtime; expects `*.wasm` files in repo root.

What agents should know (concise)
- No build system: this is a plain JS extension — edits to source files are loaded by the browser when reloading the unpacked extension.
- Background logic lives in [background.js](background.js) (service worker, ES module). Do not convert to background pages without updating `manifest.json`.
- Model code is bundled in [transformers.js](transformers.js). It configures ONNX Runtime and maps local WASM artifacts (e.g., `ort-wasm.wasm`).
- User data is stored in `chrome.storage.local` — preserve privacy; avoid introducing remote telemetry or network calls.

Developer flow (what agents can instruct humans to do)
- Load unpacked extension in Chrome/Edge: open Extensions → Developer mode → Load unpacked → select repository root.
- Use [test.html](test.html) and the popup (`popup.html`) for quick manual checks.
- To add or change models, ensure corresponding `*.wasm` files are present and referenced in `background.js`.

Agent guidelines
- Prefer minimal, reversible changes. Create small PRs focused on one responsibility.
- Preserve manifest v3 patterns: keep `background.service_worker` and `type: "module"` unless you update `manifest.json` accordingly.
- Avoid adding remote API keys or networked model fetching; this project intentionally forces local-only models (`env.allowLocalModels = true`).

Suggested next customizations (optional)
- `create-skill:fill-field-mapping` — automate adding new `PROFILE_FIELDS` entries in `config.js` and update tests.
- `create-skill:wasm-verify` — verify the presence and checksum of required `*.wasm` files.

Where to look
- Manifest and background: [manifest.json](manifest.json#L1-L24), [background.js](background.js#L1-L120)
- ML/runtime bundle: [transformers.js](transformers.js)
- UI: [popup.html](popup.html), [popup.js](popup.js)

If you want, I can also add a short `.github/copilot-instructions.md` variant or separate skills for tests or release automation.
