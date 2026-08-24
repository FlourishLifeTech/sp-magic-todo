# Magic ToDo 1.3.0

**Security hardening**
- Validates `event.source` on all inbound iframe messages to block forged requests from other plugins
- Replaces wildcard `'*'` target origin with `event.origin` on all outbound responses
- Strips `apiKey` from `magic-config-response`; the key no longer leaves host-side `plugin.js`
- Adds host-side AI proxy (`magic-ai-request` / `magic-ai-response`) so the iframe never makes direct LLM calls or holds the API key

**Bug fixes**
- Handles srcdoc iframe origin `'null'` safely in `postMessage`
- Fixes task picker regression where selecting a task after panel reopen did not update the sidebar
- Fixes iframe bootstrap `PluginAPI is not defined` crash on load
- Includes missing stylesheet in Vite-built `index.html`

**Task picker improvements**
- Adds **Level** filter: 1st level (main), 2nd level (+ subtasks), 3rd level (+ checklist)
- Adds **Tasks without subtasks** checkbox to show only leaf main tasks
- Combines search, project, level, and leaf-only filters

**Build system**
- Modularizes iframe code into `src/main.js` and `src/style.css`
- Adds Vite + `vite-plugin-singlefile` for single-file bundling
- Adds `npm run build` / `npm run zip` scripts

**Breaking changes**
- None. Existing `plugin.js` host bridge API is unchanged; only internal message handling is tightened.

**Migration**
- Re-upload `plugin.zip` from the `magic-todo-1.3.0` tag.
