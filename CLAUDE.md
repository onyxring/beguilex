# Beguilex — VS Code Extension Architecture

## Build & Test
```bash
npm run compile          # TypeScript → JS
# Reload window: Shift+Cmd+R (NOT Restart Extension Host — kills Claude Code)
```

## Key Source Files
| File | Purpose |
|------|---------|
| `extension.ts` | Commands (Play, Debug), `beguilerCommand()` builds CLI args from settings |
| `beguileDebugAdapter.ts` | DAP implementation: breakpoints, step, variables, stack frames |
| `debugPanel.ts` | WebView panel: hosts Quixe/ZVM interpreters, relays debug messages |
| `debugInfo.ts` | Loads `.bgldbg` + `.dbg` files, cross-references VM addrs ↔ bgl/inf lines |
| `semanticTokens.ts` | Semantic highlighting: types, functions, properties, enums |
| `completions.ts` | Autocomplete: keywords, type members, dot-access |
| `hover.ts` | Hover info for types, members, functions |
| `signatureHelp.ts` | Function signature display |
| `definition.ts` | Go-to-definition |
| `themeUtils.ts` | Interpreter panel theme resolution |
| `gamePanel.ts` | Non-debug play panel (Play command) |
| `variableFilterView.ts` | Debug sidebar filter for Variables pane |

## Debug Architecture

### Three-level stepping
1. **Coarse (.bgl)** — main .inf not open: `stopAddrs = allMappedVmAddrs()`, auto-step skips unmapped addresses
2. **Fine (.inf)** — main .inf open: `stopAddrs = allVmAddrs()`, stops at every sequence point
3. **Included .inf** (parser.h, verblib.h) — step into/out tracks across files

### Step behavior by command
- `next` at .inf-only addr: `stopAddrs = vmAddrsForInfFile(currentFile)` — skips called functions
- `stepIn`: `stopAddrs = allVmAddrs()` — enters called functions, bypasses auto-step
- `stepOut` at .inf-only addr: `stopAddrs = allVmAddrs() minus currentFile` — stops at caller

### I6 mode detection
I6 mode activates when: (a) main .inf pane is visible, OR (b) paused at an .inf-only address (no .bgl mapping). This affects step handler stopAddrs, auto-step in onVmBreak, and stackTrace resolveSource.

### Key fields on BeguileDebugAdapter
- `currentVmAddr` — VM address where execution paused
- `currentBglFile` / `currentBglLine` — .bgl source location (undefined if unmapped)
- `currentInfLocation` — `{path, line}` in whichever .inf file
- `lastStepCommand` — 'next' | 'stepIn' | 'stepOut' (controls auto-step bypass)

### Interpreter JS patches
- `quixe-debug.js` — Patches Quixe's `execute_loop` for breakpoint/step checks. `_bglIsPaused` prevents GlkOte arrange events from re-entering while paused.
- `zvm-debug.js` — Patches ZVM's `run()`, `resume()`, `start()`. JIT block splitter forces step boundaries. `_bglDebugBreak` flag suppresses Glk calls during break.

### GlkOte generation counter (critical bug pattern)
Calling `Glk.update()` or `Glk.glk_select()` while paused at a breakpoint consumes GlkOte's generation counter. The next real update is then ignored → game freezes. Fix: suppress both calls during `_bglDebugBreak` in `start()` and `resume()`.

## Debug File Formats
- `<stem>.bgl.bgldbg` — beguiler bundle: `[map]` (infLine→bglFile+line), `[sym]`, `[types]`
- `<stem>.bgl.transpiled.inf.dbg` — Inform 6 XML: `<routine>`, `<sequence-point>`, `<given-path>`, `<local-variable>`
- `<given-path>` entries use I6 library names without extension (e.g. "parser" not "parser.h"). `debugInfo.ts` resolves via `+include_path=` from the generated .inf.
- **Location:** beguiler emits these next to the story file in the **output folder** (all build artifacts — transpiled/debug/temp — go there alongside executables). Older builds wrote them next to the source `.bgl`. `extension.ts`'s Debug command searches both (newest-wins via `newestExisting`), locking the transpiled `.inf` + `.dbg` to whichever folder the `.bgldbg` was found in. The debug adapter/`debugInfo.ts` are driven entirely by the paths in the launch config — `extension.ts` is the only place that locates them on disk.

## Settings (package.json)
Three configuration groups: Edit & Debug (`Beguilex.*`), Beguiler (`beguiler.*`), Inform 6 (`i6.*`).
Code reads via `getConfiguration('Beguilex')`, `getConfiguration('beguiler')`, `getConfiguration('i6')`.

## Extension Identity
- `displayName: "Beguilex"` in package.json
- Extension installed as symlink: `~/.vscode/extensions/onyxring.beguile-language-0.2.0 → beguilex/`
- `package.json` changes require full window reload; sometimes requires closing VS Code entirely
