/**
 * debugPanel.ts
 * Like GamePanel, but runs the interpreter in debug mode.
 *
 * Additional responsibilities vs GamePanel:
 *  - Receives breakpoint addresses from the adapter and pushes them to the WebView.
 *  - Listens for { type:'break', addr } / { type:'step', addr } messages from
 *    the WebView and forwards them to the adapter via callbacks.
 *  - Handles the Continue / Step / Stop commands forwarded by the adapter.
 *
 * VM pause/resume mechanism:
 *  The debug panel serves media/quixe-debug.js instead of quixe.min.js.
 *  That file is a copy of quixe.min.js with one patch injected into
 *  execute_loop — before each path is executed it checks
 *  window._bglBP (a Set of break addresses).  If the current PC is in
 *  the set, it sets done_executing=true and calls window._bglOnBreak(pc),
 *  which posts a 'break' message back here.  After Continue/Step the
 *  extension host posts 'continue' / 'step' to the WebView, which calls
 *  Quixe.resume() to re-enter execute_loop.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { resolveIsLight, themeColors } from './themeUtils';

let _outputChannel: vscode.OutputChannel | null = null;
export function setDebugPanelOutputChannel(ch: vscode.OutputChannel): void {
    _outputChannel = ch;
}
function panelLog(msg: string): void {
    _outputChannel?.appendLine(`[panel] ${msg}`);
}

export class DebugPanel {
    static readonly viewType = 'beguile.debugPanel';

    private panel:        vscode.WebviewPanel;
    private disposables:  vscode.Disposable[] = [];
    private _disposed = false;
    /** Per-source-file breakpoint addresses — merged to form the live BP set.
     *  VS Code sends one setBreakpoints per file; we must accumulate, not replace. */
    private pendingAddrsByFile = new Map<string, Set<number>>();
    private storyPath:    string;
    private isZMachine:   boolean;
    private lastColumn:      vscode.ViewColumn | undefined;
    private onBreak:         (addr: number, vmState: any) => void;
    private onStep:          (addr: number, vmState: any) => void;
    private onClose:         (column: vscode.ViewColumn | undefined) => void;
    onDebugOutput?:          (text: string) => void;
    private pendingPropReads = new Map<number, (value: number | number[] | null) => void>();
    private pendingWrites    = new Map<number, (ok: boolean) => void>();
    private pendingDecodes   = new Map<number, (value: string | null) => void>();
    private pendingAttrReads = new Map<number, (value: number[] | null) => void>();
    private pendingDictWords = new Map<number, (value: string | null) => void>();
    private nextReqId        = 0;

    static createForAdapter(
        context:    vscode.ExtensionContext,
        storyPath:  string,
        isZMachine: boolean,
        viewColumn: vscode.ViewColumn,
        onBreak:    (addr: number, vmState: any) => void,
        onStep:     (addr: number, vmState: any) => void,
        onClose:    (column: vscode.ViewColumn | undefined) => void
    ): DebugPanel {
        const nmRoot    = path.join(context.extensionPath, 'node_modules');
        const mediaRoot = path.join(context.extensionPath, 'media');

        const panel = vscode.window.createWebviewPanel(
            DebugPanel.viewType,
            `Debug: ${path.basename(storyPath)}`,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(nmRoot, 'quixe')),
                    vscode.Uri.file(path.join(nmRoot, 'ifvms')),
                    vscode.Uri.file(mediaRoot),
                ]
            }
        );

        return new DebugPanel(panel, context, storyPath, isZMachine, onBreak, onStep, onClose);
    }

    private constructor(
        panel:      vscode.WebviewPanel,
        context:    vscode.ExtensionContext,
        storyPath:  string,
        isZMachine: boolean,
        onBreak:    (addr: number, vmState: any) => void,
        onStep:     (addr: number, vmState: any) => void,
        onClose:    (column: vscode.ViewColumn | undefined) => void
    ) {
        this.panel      = panel;
        this.storyPath  = storyPath;
        this.isZMachine = isZMachine;
        this.lastColumn = panel.viewColumn;
        this.onBreak    = onBreak;
        this.onStep     = onStep;
        this.onClose    = onClose;

        this.panel.webview.html = this.buildHtml(context, isZMachine);

        this.panel.onDidChangeViewState(e => {
            if (e.webviewPanel.viewColumn !== undefined) {
                this.lastColumn = e.webviewPanel.viewColumn;
            }
        }, null, this.disposables);

        this.panel.onDidDispose(() => {
            this.onClose(this.lastColumn);
            this.dispose();
        }, null, this.disposables);

        const sendTheme = () => this.panel.webview.postMessage(
            { type: 'setTheme', ...themeColors(resolveIsLight()) }
        );
        vscode.window.onDidChangeActiveColorTheme(() => sendTheme(), null, this.disposables);
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('beguile.interpreterTheme')) sendTheme();
        }, null, this.disposables);

        // Messages from WebView
        this.panel.webview.onDidReceiveMessage(
            (msg: { type: string; addr?: number; vmState?: any; reqId?: number; value?: any; ok?: boolean; decoded?: string | null; msg?: string }) => {
                if (msg.type === 'debugLog') {
                    panelLog(msg.msg ?? '');
                } else if (msg.type === 'debugOutput') {
                    if (this.onDebugOutput) { this.onDebugOutput(msg.msg ?? (msg as any).text ?? ''); }
                } else if (msg.type === 'break' && msg.addr !== undefined) {
                    this.onBreak(msg.addr, msg.vmState ?? { frames: [], globals: {} });
                } else if (msg.type === 'step' && msg.addr !== undefined) {
                    this.onStep(msg.addr, msg.vmState ?? { frames: [], globals: {} });
                } else if (msg.type === 'stop') {
                    this.panel.dispose();
                } else if (msg.type === 'propertyResult' && msg.reqId !== undefined) {
                    const resolve = this.pendingPropReads.get(msg.reqId);
                    if (resolve) {
                        this.pendingPropReads.delete(msg.reqId);
                        resolve(msg.value ?? null);
                    }
                } else if (msg.type === 'writeResult' && msg.reqId !== undefined) {
                    const resolve = this.pendingWrites.get(msg.reqId);
                    if (resolve) {
                        this.pendingWrites.delete(msg.reqId);
                        resolve(msg.ok === true);
                    }
                } else if (msg.type === 'decodeStringResult' && msg.reqId !== undefined) {
                    const resolve = this.pendingDecodes.get(msg.reqId);
                    if (resolve) {
                        this.pendingDecodes.delete(msg.reqId);
                        resolve(msg.decoded ?? null);
                    }
                } else if (msg.type === 'readAttrsResult' && msg.reqId !== undefined) {
                    const resolve = this.pendingAttrReads.get(msg.reqId);
                    if (resolve) {
                        this.pendingAttrReads.delete(msg.reqId);
                        resolve(Array.isArray(msg.value) ? msg.value : null);
                    }
                } else if (msg.type === 'decodeDictWordResult' && msg.reqId !== undefined) {
                    const resolve = this.pendingDictWords.get(msg.reqId);
                    if (resolve) {
                        this.pendingDictWords.delete(msg.reqId);
                        resolve(msg.decoded ?? null);
                    }
                }
            },
            null,
            this.disposables
        );
    }

    /** Called by the adapter after configurationDone — reads the story and starts the game. */
    startGame(globalAddresses: number[] = []): void {
        try {
            const buffer = fs.readFileSync(this.storyPath);
            // Include the initial breakpoint set IN the startGame message so the
            // webview can set _bglBP BEFORE calling GiLoad.load_run().  Without this,
            // games that have no @read (no blocking I/O) complete their entire execution
            // synchronously inside the 'startGame' handler — before a separate
            // 'setBreakpoints' message could be processed — so no breakpoints would fire.
            this.panel.webview.postMessage({
                type: 'startGame',
                storyBase64: buffer.toString('base64'),
                isZMachine: this.isZMachine,
                debugMode: true,
                globalAddresses,
                initialBreakpoints: [...this.mergedAddrs()],
            });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'error', msg: String(e) });
        }
    }

    /** Merge all per-file breakpoint sets into one flat set. */
    private mergedAddrs(): Set<number> {
        const all = new Set<number>();
        for (const s of this.pendingAddrsByFile.values()) { for (const a of s) { all.add(a); } }
        return all;
    }

    /** Push the current set of VM break addresses to the WebView.
     *  src identifies which source file these addresses belong to so that
     *  breakpoints from other files are preserved when one file is updated. */
    updateBreakpoints(src: string, addrs: Set<number>): void {
        this.pendingAddrsByFile.set(src, addrs);
        this.panel.webview.postMessage({
            type: 'setBreakpoints',
            addresses: Array.from(this.mergedAddrs()),
        });
    }

    /** Tell the WebView to resume execution (continue). */
    sendContinue(): void {
        this.panel.webview.postMessage({ type: 'continue' });
    }

    /** Tell the WebView to resume in step mode.
     *  skipAddrs: addresses on the same I6/bgl line as current — don't stop there.
     *  stopAddrs: addresses to stop at — empty means stop after first path.
     */
    sendStep(skipAddrs: number[], stopAddrs: number[], seqPts?: number[]): void {
        this.panel.webview.postMessage({ type: 'step', skipAddrs, stopAddrs, seqPts });
    }

    private buildHtml(context: vscode.ExtensionContext, isZMachine: boolean): string {
        const w = this.panel.webview;
        const { bg, fg, inputClr, accentBg, markBg, loadClr } = themeColors(resolveIsLight());

        const nm = (...parts: string[]): vscode.Uri =>
            w.asWebviewUri(vscode.Uri.file(
                path.join(context.extensionPath, 'node_modules', ...parts)
            ));
        const media = (...parts: string[]): vscode.Uri =>
            w.asWebviewUri(vscode.Uri.file(
                path.join(context.extensionPath, 'media', ...parts)
            ));

        const jqueryJs   = nm('quixe', 'src', 'quixe', 'lib', 'jquery-1.12.4.min.js');
        const glkoteJs   = nm('quixe', 'src', 'quixe', 'lib', 'glkote.min.js');
        const quixeDbgJs = media('quixe-debug.js');
        const zvmDbgJs   = media('zvm-debug.js');
        const glkoteCss  = nm('quixe', 'src', 'quixe', 'media', 'i7-glkote.css');
        const dialogCss  = nm('quixe', 'src', 'quixe', 'media', 'dialog.css');
        const zvmJs      = nm('ifvms', 'dist', 'zvm.js');

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, user-scalable=no">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src ${w.cspSource} data:;
           style-src ${w.cspSource} 'unsafe-inline';
           script-src ${w.cspSource} 'unsafe-inline' 'unsafe-eval';">
<link rel="stylesheet" href="${glkoteCss}">
<link rel="stylesheet" href="${dialogCss}">
<style>
  :root {
    --bgl-bg: ${bg}; --bgl-fg: ${fg}; --bgl-input: ${inputClr};
    --bgl-accent: ${accentBg}; --bgl-mark: ${markBg}; --bgl-load: ${loadClr};
  }
  html, body { height: 100%; width: 100%; margin: 0; padding: 0; background: var(--bgl-bg); color: var(--bgl-fg); }
  #gameport  { bottom: 0; left: 0; right: 0; top: 0; margin: 0 auto; max-width: 900px; position: absolute; overflow: clip; }
  #windowport { height: 100%; position: relative; width: 100%; }
  #loadingpane { color: var(--bgl-load); padding: 16px; font-family: monospace; text-align: center; top: 20%; position: absolute; width: 100%; }
  .WindowFrame  { background: var(--bgl-bg); }
  .BufferWindow { background: var(--bgl-bg); color: var(--bgl-fg); font-family: Georgia, serif; font-size: 15px; line-height: 1.4; padding: 6px 10px; overflow: scroll; overflow-x: hidden; }
  .GridWindow   { background: var(--bgl-fg); color: var(--bgl-bg); font-family: "Lucida Console", "DejaVu Sans Mono", monospace; font-size: 14px; line-height: 18px; padding: 6px 10px; overflow: hidden; }
  .GridLine { white-space: pre; }
  .Input { color: var(--bgl-input); font-weight: bold; border: none; margin: 0; padding: 0; outline: none; background: none; }
  .BufferWindow .Input { font-family: Georgia, serif; font-size: 15px; }
  .GridWindow   .Input { font-family: "Lucida Console", "DejaVu Sans Mono", monospace; font-size: 14px; }
  .Style_emphasized { font-style: italic; }
  .Style_preformatted { font-family: "Lucida Console", "DejaVu Sans Mono", monospace; }
  .Style_header { font-weight: bold; font-size: 17px; }
  .Style_subheader { font-weight: bold; }
  .Style_alert { font-weight: bold; }
  .Style_note { font-style: italic; }
  .Style_blockquote { background: var(--bgl-accent); }
  .Style_input { color: var(--bgl-input); font-weight: bold; }
  .InvisibleCursor { position: relative; padding-bottom: 14px; }
  .MorePrompt { font-weight: bold; position: absolute; background: var(--bgl-accent); color: var(--bgl-fg); opacity: 0.8; padding: 2px 6px; border-radius: 4px; }
  .PreviousMark { position: absolute; background: var(--bgl-mark); height: 2px; width: 12px; top: 0; right: 0; }

</style>
<title>Beguile Debug</title>
</head>
<body>
<div id="gameport">
  <div id="windowport"></div>
  <div id="loadingpane">Loading…</div>
  <div id="errorpane" style="display:none;"><div id="errorcontent"></div></div>
</div>


<script src="${jqueryJs}"></script>
<script src="${glkoteJs}"></script>
<script src="${quixeDbgJs}"></script>
${isZMachine ? `<script src="${zvmJs}"></script><script src="${zvmDbgJs}"></script>` : ''}

<script>
(function () {
    var vscode = acquireVsCodeApi();
    var _bglIsZMachine = false;

    // Log helper usable from zvm-debug.js / quixe-debug.js (no vscode access there).
    window._bglLog = function(msg) {
        vscode.postMessage({ type: 'debugLog', msg: msg });
    };

    // Breakpoint address set — the patched execute_loop checks this.
    window._bglBP = new Set();

    // Called by the patched execute_loop when VM hits a break address.
    window._bglOnBreak = function(pc) {
        window._bglPausedPC = pc;
        var vmState = window._bglGetVmState ? window._bglGetVmState() : { frames: [], globals: {} };
        vscode.postMessage({ type: 'break', addr: pc, vmState: vmState });
    };

    // Called by the patched execute_loop after a single-path step.
    window._bglOnStep = function(pc) {
        window._bglPausedPC = pc;
        var vmState = window._bglGetVmState ? window._bglGetVmState() : { frames: [], globals: {} };
        vscode.postMessage({ type: 'step', addr: pc, vmState: vmState });
    };

    function setRunning() {
        // no-op — status bar removed; breakpoint count tracked internally only
    }

    // Debug output capture — mirrors game text to the extension host
    // so it appears in the Debug Console immediately.
    window._bglDebugOutput = function(text) {
        vscode.postMessage({ type: 'debugOutput', text: text });
    };

    // Messages from extension host
    window.addEventListener('message', function (event) {
        var msg = event.data;

        if (msg.type === 'startGame') {
            if (msg.globalAddresses) {
                window._bglTrackedGlobalAddrs = msg.globalAddresses;
            }
            /* Set breakpoints BEFORE starting the game so that games with no
             * blocking @read (which execute synchronously inside GiLoad.load_run)
             * can still hit their breakpoints on the very first run. */
            if (msg.initialBreakpoints && msg.initialBreakpoints.length > 0) {
                window._bglBP = new Set(msg.initialBreakpoints);
            }
            _bglIsZMachine = !!msg.isZMachine;
            var binary = atob(msg.storyBase64);
            var storyArray = _bglIsZMachine ? new Uint8Array(binary.length) : new Array(binary.length);
            for (var i = 0; i < binary.length; i++) storyArray[i] = binary.charCodeAt(i);
            /* ZVM is a class constructor; GiLoad expects a singleton with prepare()/resume()
               on it directly, so instantiate first. ZVM.prepare() also requires options.Glk
               (GiLoad only sets options.io, not options.Glk).
               GiDispa is the Quixe/Glulx dispatch layer; ZVM has its own Glk bindings and
               must not have GiDispa attached (it causes retain_array errors on line input). */
            if (_bglIsZMachine) { window.ZVM = new ZVM(); window.GiDispa = null; }
            var vm = _bglIsZMachine ? ZVM : Quixe;
            var glkOpt = _bglIsZMachine ? { Glk: window.Glk } : {};

            GiLoad.load_run(Object.assign({ vm: vm, use_query_story: false }, glkOpt), storyArray, 'array');
            /* Prevent GlkOte arrange/timer events from re-entering execute_loop while
             * the debugger is paused. Opening source files in VS Code can resize the
             * webview, firing an arrange event that calls Quixe.resume() and runs the game. */
            if (!_bglIsZMachine) {
                var _origQuixeResume = Quixe.resume;
                Quixe.resume = function(glk_event) {
                    if (window._bglIsPaused) { return; }
                    return _origQuixeResume.call(this, glk_event);
                };
                /* Wrap Glk.glk_put_jstring to mirror game text to Debug Console */
                if (window.Glk && window.Glk.glk_put_jstring) {
                    var _origPutJstring = window.Glk.glk_put_jstring;
                    window.Glk.glk_put_jstring = function(text, allbytes) {
                        _origPutJstring.call(this, text, allbytes);
                        if (window._bglDebugOutput) { window._bglDebugOutput(text); }
                    };
                }
            }

        } else if (msg.type === 'setTheme') {
            var r = document.documentElement.style;
            r.setProperty('--bgl-bg',     msg.bg);
            r.setProperty('--bgl-fg',     msg.fg);
            r.setProperty('--bgl-input',  msg.inputClr);
            r.setProperty('--bgl-accent', msg.accentBg);
            r.setProperty('--bgl-mark',   msg.markBg);
            r.setProperty('--bgl-load',   msg.loadClr);

        } else if (msg.type === 'setBreakpoints') {
            window._bglBP = new Set(msg.addresses);
            /* Invalidate JIT cache so blocks recompile with splits at BP addresses */
            if (_bglIsZMachine && window._bglZvmInstance) {
                window._bglZvmInstance.jit = {};
            }
            if (!window._bglPausedPC) {
                setRunning();
            }

        } else if (msg.type === 'continue') {
            window._bglSkipPC = window._bglPausedPC;
            window._bglPausedPC = null;
            window._bglIsPaused = false;
            setRunning();
            if (_bglIsZMachine && window._bglZvmInstance) {
                window._bglZvmInstance._bglContinue();
            } else {
                Quixe.resume();
            }

        } else if (msg.type === 'step') {
            window._bglSkipPC = window._bglPausedPC;
            window._bglPausedPC = null;
            if (_bglIsZMachine) {
                /* Set seq-pt split addresses for the JIT block splitter (zvm-debug.js).
                 * Always clear the JIT cache so blocks recompile with proper splits.
                 * Previously only cleared when seqPts changed, but blocks compiled
                 * during start() or earlier steps may lack needed split points. */
                if (msg.seqPts) {
                    window._bglAllSeqPtAddrs = new Set(msg.seqPts);
                }
                if (window._bglZvmInstance) {
                    window._bglZvmInstance.jit = {};
                }
            } else {
                /* seqPts / path-cache invalidation is Quixe-specific. */
                window._bglSeqPts = msg.seqPts ? new Set(msg.seqPts) : null;
                if (msg.seqPts && window._bglCurrentVmFunc && window._bglCurrentIosys !== undefined) {
                    window._bglCurrentVmFunc[window._bglCurrentIosys] = {};
                }
            }
            window._bglStepSkipAddrs = msg.skipAddrs ? new Set(msg.skipAddrs) : null;
            window._bglStepStopAt   = msg.stopAddrs && msg.stopAddrs.length
                ? new Set(msg.stopAddrs) : null;
            window._bglStepMode = true;
            window._bglIsPaused = false;
            setRunning();
            if (_bglIsZMachine && window._bglZvmInstance) {
                window._bglZvmInstance._bglContinue();
            } else {
                Quixe.resume();
            }

        } else if (msg.type === 'readProperty') {
            var propVal = null;
            if (window._bglReadProp) {
                try { propVal = window._bglReadProp(msg.obj, msg.propId); } catch(e) {}
            }
            vscode.postMessage({ type: 'propertyResult', reqId: msg.reqId, value: propVal });

        } else if (msg.type === 'setProp') {
            var okp = false;
            if (window._bglSetProp) {
                try { okp = window._bglSetProp(msg.obj, msg.propId, msg.value); } catch(e) {}
            }
            vscode.postMessage({ type: 'writeResult', reqId: msg.reqId, ok: okp });

        } else if (msg.type === 'setGlobal') {
            var ok = false;
            if (window._bglSetGlobal) {
                try {
                    var setResult = window._bglSetGlobal(msg.address, msg.value);
                    if (setResult === true) { ok = true; }
                    else { vscode.postMessage({ type: 'debugLog', msg: '[setGlobal] failed: ' + setResult + ' addr=' + msg.address + ' val=' + msg.value }); }
                } catch(e) { vscode.postMessage({ type: 'debugLog', msg: '[setGlobal] exception: ' + e }); }
            } else { vscode.postMessage({ type: 'debugLog', msg: '[setGlobal] _bglSetGlobal not defined' }); }
            vscode.postMessage({ type: 'writeResult', reqId: msg.reqId, ok: ok });

        } else if (msg.type === 'setLocal') {
            var ok2 = false;
            if (window._bglSetLocal) {
                try { ok2 = window._bglSetLocal(msg.stackIdx, msg.offset, msg.value); } catch(e) {}
            }
            vscode.postMessage({ type: 'writeResult', reqId: msg.reqId, ok: ok2 });

        } else if (msg.type === 'decodeString') {
            var decoded = null;
            if (window._bglDecodeString) {
                try { decoded = window._bglDecodeString(msg.addr); } catch(e) {}
            }
            vscode.postMessage({ type: 'decodeStringResult', reqId: msg.reqId, decoded: decoded });

        } else if (msg.type === 'readAttrs') {
            var attrBytes = null;
            if (window._bglReadAttrs) {
                try { attrBytes = window._bglReadAttrs(msg.obj); } catch(e) {}
            }
            vscode.postMessage({ type: 'readAttrsResult', reqId: msg.reqId, value: attrBytes });

        } else if (msg.type === 'decodeDictWord') {
            var dictWord = null;
            if (window._bglDecodeDictWord) {
                try { dictWord = window._bglDecodeDictWord(msg.addr); } catch(e) {}
            }
            vscode.postMessage({ type: 'decodeDictWordResult', reqId: msg.reqId, decoded: dictWord });

        } else if (msg.type === 'error') {
            document.getElementById('errorcontent').textContent = msg.msg;
            document.getElementById('errorpane').style.display = '';
            document.getElementById('loadingpane').style.display = 'none';
        }
    });
}());
</script>
</body>
</html>`;
    }

    /**
     * Ask the WebView to read a single object property from live VM memory.
     * Returns the property value (number), an array for multi-word properties,
     * or null if the property is absent on the object.
     * Must only be called while the VM is paused.
     */
    readProperty(obj: number, propId: number): Promise<number | number[] | null> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingPropReads.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'readProperty', reqId, obj, propId });
        });
    }

    /** Write a scalar value to a single-word object property in VM memory. */
    setProp(obj: number, propId: number, value: number): Promise<boolean> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingWrites.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'setProp', reqId, obj, propId, value });
        });
    }

    /** Write a value to a global variable address in VM memory. */
    setGlobal(address: number, value: number): Promise<boolean> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingWrites.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'setGlobal', reqId, address, value });
        });
    }

    /** Decode a Glulx string at the given VM address. Returns the text, or null if not decodable. */
    decodeString(addr: number): Promise<string | null> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingDecodes.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'decodeString', reqId, addr });
        });
    }

    /** Read the 7 attribute bytes from an object header in live VM memory. */
    readAttributes(obj: number): Promise<number[] | null> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingAttrReads.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'readAttrs', reqId, obj });
        });
    }

    /** Decode a Glulx dictionary word at the given VM address. Returns the word text, or null. */
    decodeDictWord(addr: number): Promise<string | null> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingDictWords.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'decodeDictWord', reqId, addr });
        });
    }

    /**
     * Write a value to a local variable in a specific stack frame.
     * stackIdx = index into Quixe's stack array (0=outermost, length-1=innermost).
     * offset   = frame-offset from the .dbg file.
     */
    setLocal(stackIdx: number, offset: number, value: number): Promise<boolean> {
        const reqId = this.nextReqId++;
        return new Promise(resolve => {
            this.pendingWrites.set(reqId, resolve);
            this.panel.webview.postMessage({ type: 'setLocal', reqId, stackIdx, offset, value });
        });
    }

    dispose(): void {
        if (this._disposed) { return; }
        this._disposed = true;
        // Resolve any outstanding property-read / write / decode promises so callers don't hang.
        for (const resolve of this.pendingPropReads.values()) { resolve(null); }
        this.pendingPropReads.clear();
        for (const resolve of this.pendingWrites.values()) { resolve(false); }
        this.pendingWrites.clear();
        for (const resolve of this.pendingDecodes.values()) { resolve(null); }
        this.pendingDecodes.clear();
        for (const resolve of this.pendingAttrReads.values()) { resolve(null); }
        this.pendingAttrReads.clear();
        for (const resolve of this.pendingDictWords.values()) { resolve(null); }
        this.pendingDictWords.clear();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.panel.dispose(); // close the VS Code webview panel
    }
}
